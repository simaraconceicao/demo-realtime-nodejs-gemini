require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { Buffer } = require('node:buffer');
const { GoogleGenAI, createUserContent } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not found in environment variables.');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const geminiSessionMap = new Map();
const audioBuffers = new Map();

function createWavHeader(pcmDataLength, sampleRate, bitsPerSample, numChannels) {
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const riffChunkSize = pcmDataLength + 36;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(riffChunkSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmDataLength, 40);

    return header;
}

wss.on('connection', async (ws) => {
    console.log('INFO: Frontend connected');
    audioBuffers.set(ws, { buffer: Buffer.alloc(0), mimeType: '' });

    const connectParams = {
        model: 'gemini-2.0-flash-live-001',
        callbacks: {
            onopen: () => {
                console.log('INFO: Gemini Live session opened');
            },
            onmessage: (liveServerMessage) => {
                console.log('DEBUG: --- Received message from Gemini ---');
                console.log('DEBUG:', JSON.stringify(liveServerMessage, null, 2));
                console.log('DEBUG: ------------------------------------');

                const buffer = audioBuffers.get(ws);
                if (!buffer) {
                    console.error('ERROR: Audio buffer not found for WebSocket.');
                    return;
                }

                if (liveServerMessage.serverContent) {
                    if (liveServerMessage.serverContent.modelTurn && liveServerMessage.serverContent.modelTurn.parts) {
                        liveServerMessage.serverContent.modelTurn.parts.forEach(part => {
                            if (part.text) {
                                ws.send(JSON.stringify({ from: 'gemini', type: 'text', data: part.text }));
                            }
                            if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('audio/')) {
                                const audioChunk = Buffer.from(part.inlineData.data, 'base64');
                                buffer.buffer = Buffer.concat([buffer.buffer, audioChunk]);
                                buffer.mimeType = part.inlineData.mimeType;
                            }
                        });
                    }
                    if (liveServerMessage.serverContent.turnComplete) {
                        if (buffer.buffer && buffer.buffer.length > 0) {
                            const sampleRate = 24000;
                            const bitsPerSample = 16;
                            const numChannels = 1;
                            const wavHeader = createWavHeader(buffer.buffer.length, sampleRate, bitsPerSample, numChannels);
                            const finalAudioBuffer = Buffer.concat([wavHeader, buffer.buffer]);
                            const finalAudioBase64 = finalAudioBuffer.toString('base64');
                            ws.send(JSON.stringify({ from: 'gemini', type: 'audio', data: { audio: finalAudioBase64, mimeType: 'audio/wav' } }));
                            buffer.buffer = Buffer.alloc(0);
                            buffer.mimeType = '';
                        }
                    }
                }
            },
            onerror: (error) => {
                console.error(`ERROR: Gemini Live session error: ${error.message || 'Unknown error'}`);
                if (error.stack) console.error('ERROR: Stack:', error.stack);
                ws.close(1011, 'Gemini API Error');
            },
            onclose: (closeEvent) => {
                console.log(`INFO: Gemini Live session closed. Code: ${closeEvent.code}, Reason: ${closeEvent.reason || 'N/A'}, WasClean: ${closeEvent.wasClean}`);
                audioBuffers.delete(ws);
            }
        },
        config: {}
    };

    try {
        const session = await ai.live.connect(connectParams);
        geminiSessionMap.set(ws, session);

        ws.on('message', (message) => {
            try {
                const frontendMessage = JSON.parse(message);
                const currentSession = geminiSessionMap.get(ws);

                if (!currentSession) {
                    console.error('ERROR: No Gemini session found for this WebSocket.');
                    ws.close(1011, 'No active Gemini session');
                    return;
                }

                if (frontendMessage.type === 'text') {
                    const content = createUserContent(frontendMessage.message);
                    currentSession.sendClientContent({ turns: [content], turnComplete: true });
                } else if (frontendMessage.type === 'audio') {
                    const audioBlob = Buffer.from(frontendMessage.audioData, 'base64');
                    const inputStream = new PassThrough();
                    const pcmStream = new PassThrough();
                    const pcmChunks = [];

                    pcmStream.on('data', (chunk) => {
                        pcmChunks.push(chunk);
                    });

                    pcmStream.on('end', async () => {
                        const pcmData = Buffer.concat(pcmChunks);
                        const pcmBase64 = pcmData.toString('base64');
                        const pcmBlobPart = { data: pcmBase64, mimeType: 'audio/pcm;rate=24000' };
                        currentSession.sendRealtimeInput({ audio: pcmBlobPart });
                    });

                    pcmStream.on('error', (err) => {
                        console.error('ERROR: FFmpeg stream error:', err.message || 'Unknown error');
                        ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Audio conversion failed: ' + (err.message || 'Unknown FFmpeg error') }));
                    });

                    ffmpeg()
                        .input(inputStream)
                        .inputFormat('webm')
                        .toFormat('s16le')
                        .audioChannels(1)
                        .audioFrequency(24000)
                        .on('start', function (commandLine) {
                            console.log('DEBUG: Spawned FFmpeg with command: ' + commandLine);
                        })
                        .on('error', function (err) {
                            console.error('ERROR: FFmpeg process error:', err.message || 'Unknown error');
                        })
                        .on('end', function () {
                            console.log('INFO: FFmpeg process finished.');
                            pcmStream.end();
                        })
                        .pipe(pcmStream);

                    inputStream.end(audioBlob);
                }
            } catch (error) {
                console.error(`ERROR: Error processing frontend message: ${error.message || 'Unknown error'}`);
                if (error.stack) console.error('ERROR: Stack:', error.stack);
                ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error processing message: ' + (error.message || 'Unknown error') }));
            }
        });

        ws.on('close', () => {
            console.log('INFO: Frontend disconnected');
            const session = geminiSessionMap.get(ws);
            if (session) {
                session.close();
                geminiSessionMap.delete(ws);
            }
            audioBuffers.delete(ws);
        });

        ws.on('error', (error) => {
            console.error(`ERROR: WebSocket error: ${error.message || 'Unknown error'}`);
            if (error.stack) console.error('ERROR: Stack:', error.stack);
            const session = geminiSessionMap.get(ws);
            if (session) {
                session.close();
                geminiSessionMap.delete(ws);
            }
            audioBuffers.delete(ws);
        });
    } catch (error) {
        console.error(`FATAL ERROR: Error connecting to Gemini Live: ${error.message || 'Unknown error'}`);
        if (error.stack) console.error('ERROR: Stack:', error.stack);
        audioBuffers.delete(ws);
        ws.close(1011, 'Backend connection error');
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`INFO: Backend listening on port ${PORT}`);
    console.log(`INFO: WebSocket server running on ws://localhost:${PORT}`);
});
