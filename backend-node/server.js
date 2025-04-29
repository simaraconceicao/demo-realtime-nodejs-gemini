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
    console.error('[BE:Config] ERROR: GEMINI_API_KEY not found in environment variables.');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const geminiSessionMap = new Map();
const clientStateMap = new Map();

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

function truncateAudioData(obj, maxLength = 100) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    const clonedObj = JSON.parse(JSON.stringify(obj));

    function traverse(current) {
        if (current === null || typeof current !== 'object') {
            return;
        }
        for (const key in current) {
            if (typeof current[key] === 'string') {
                if ((key === 'data' || key === 'audio' || key === 'audioData') && current[key].length > maxLength) {
                    if (/^[a-zA-Z0-9+/=]/.test(current[key].substring(0, 50))) {
                        current[key] = current[key].substring(0, maxLength) + '...[TRUNCATED]';
                    }
                }
            } else if (typeof current[key] === 'object') {
                traverse(current[key]);
            }
        }
    }

    traverse(clonedObj);
    return clonedObj;
}


function cleanupClient(ws) {
    console.info('[BE:Cleanup] Cleaning up client resources.');
    const clientState = clientStateMap.get(ws);
    if (clientState) {
        console.debug('[BE:Cleanup] Client state found.');
        if (clientState.ffmpegInputStream) {
            console.debug('[BE:Cleanup] Destroying FFmpeg input stream.');
            clientState.ffmpegInputStream.destroy();
        }
        if (clientState.pcmOutputStream) {
            console.debug('[BE:Cleanup] Destroying PCM output stream.');
            clientState.pcmOutputStream.destroy();
        }
        if (clientState.ffmpegProcess) {
            console.debug('[BE:Cleanup] Killing FFmpeg process.');
            try {
                process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
            } catch (e) {
                console.debug('[BE:Cleanup] FFmpeg process already finished or not found:', e.message);
            }
        }
    }

    const session = geminiSessionMap.get(ws);
    if (session) {
        console.debug('[BE:Cleanup] Closing Gemini session.');
        session.close();
        geminiSessionMap.delete(ws);
    }

    clientStateMap.delete(ws);
    console.info('[BE:Cleanup] Client resources cleaned.');
}


wss.on('connection', async (ws) => {
    console.info('[BE:WS] Frontend connected');
    clientStateMap.set(ws, { audioBuffer: Buffer.alloc(0), mimeType: '', ffmpegInputStream: null, ffmpegProcess: null, pcmOutputStream: null, isSendingAudioToGemini: false, firstGeminiResponseReceived: false });

    const connectParams = {
        model: 'gemini-2.0-flash-live-001',
        callbacks: {
            onopen: () => {
                console.info('[BE:Gemini] Live session opened');
            },
            onmessage: (liveServerMessage) => {
                console.debug('[BE:Gemini] --- Received message from Gemini ---');
                console.debug('[BE:Gemini]', JSON.stringify(truncateAudioData(liveServerMessage), null, 2));

                const clientState = clientStateMap.get(ws);
                if (!clientState) {
                    console.error('[BE:Gemini] Client state not found for WebSocket.');
                    return;
                }

                if (!clientState.firstGeminiResponseReceived) {
                    console.info('[BE:Gemini] First response received from Gemini.');
                    clientState.firstGeminiResponseReceived = true;
                }

                if (liveServerMessage.serverContent) {
                    if (liveServerMessage.serverContent.modelTurn && liveServerMessage.serverContent.modelTurn.parts) {
                        liveServerMessage.serverContent.modelTurn.parts.forEach(part => {
                            if (part.text) {
                                ws.send(JSON.stringify({ from: 'gemini', type: 'text', data: part.text }));
                                console.debug('[BE:WS] Sent text part to frontend.');
                            }
                            if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('audio/')) {
                                console.debug('[BE:Gemini] Received audio chunk (Base64 PCM).');
                                const audioChunkBase64 = part.inlineData.data;
                                if (audioChunkBase64) {
                                    try {
                                        clientState.audioBuffer = Buffer.concat([clientState.audioBuffer, Buffer.from(audioChunkBase64, 'base64')]);
                                        clientState.mimeType = part.inlineData.mimeType;
                                        console.debug(`[BE:Gemini] Buffered audio chunk. Total buffered: ${clientState.audioBuffer.length} bytes.`);
                                    } catch (bufferError) {
                                        console.error('[BE:Gemini] Error processing Gemini audio chunk:', bufferError);
                                    }
                                } else {
                                    console.warn('[BE:Gemini] Received audio part with no data.');
                                }
                            }
                        });
                    }
                    if (liveServerMessage.serverContent.turnComplete) {
                        console.info('[BE:Gemini] Gemini turn complete received.');
                        clientState.firstGeminiResponseReceived = false;
                        if (clientState.audioBuffer && clientState.audioBuffer.length > 0) {
                            const sampleRate = 24000;
                            const bitsPerSample = 16;
                            const numChannels = 1;
                            try {
                                console.info('[BE:Audio] Creating WAV header and sending buffered audio.');
                                const wavHeader = createWavHeader(clientState.audioBuffer.length, sampleRate, bitsPerSample, numChannels);
                                const finalAudioBuffer = Buffer.concat([wavHeader, clientState.audioBuffer]);
                                const finalAudioBase64 = finalAudioBuffer.toString('base64');

                                ws.send(JSON.stringify({ from: 'gemini', type: 'audio', data: { audio: finalAudioBase64, mimeType: 'audio/wav' } }));
                                console.info('[BE:WS] Sent complete WAV audio (Base64 in JSON) to frontend.');

                                clientState.audioBuffer = Buffer.alloc(0);
                                clientState.mimeType = '';

                            } catch (wavError) {
                                console.error('[BE:Audio] Error creating WAV or sending audio:', wavError);
                                ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error processing Gemini audio: ' + (wavError.message || 'Unknown audio error') }));
                            }

                        } else {
                            console.info('[BE:Audio] Gemini turn complete, but no audio buffered.');
                        }

                        ws.send(JSON.stringify({ from: 'gemini', type: 'turnComplete' }));
                        console.debug('[BE:WS] Sent turnComplete signal to frontend.');
                    }
                }
            },
            onerror: (error) => {
                console.error(`[BE:Gemini] Live session error: ${error.message || 'Unknown error'}`);
                if (error.stack) console.error('[BE:Gemini] Stack:', error.stack);
                ws.close(1011, 'Gemini API Error');
            },
            onclose: (closeEvent) => {
                console.info(`[BE:Gemini] Live session closed. Code: ${closeEvent.code}, Reason: ${closeEvent.reason || 'N/A'}, WasClean: ${closeEvent.wasClean}`);
            }
        },
        config: {}
    };

    try {
        const session = await ai.live.connect(connectParams);
        geminiSessionMap.set(ws, session);
        console.info('[BE:Gemini] Live session connected for client.');


        ws.on('message', (message) => {
            try {
                const currentSession = geminiSessionMap.get(ws);
                const clientState = clientStateMap.get(ws);

                if (!currentSession) {
                    console.error('[BE:WS] No Gemini session found for this WebSocket.');
                    ws.close(1011, 'No active Gemini session');
                    return;
                }
                if (!clientState) {
                    console.error('[BE:WS] No client state found for this WebSocket.');
                    ws.close(1011, 'No active client state');
                    return;
                }

                const frontendMessage = JSON.parse(message);
                console.debug('[BE:WS] Received JSON message:', JSON.stringify(truncateAudioData(frontendMessage)));


                if (frontendMessage.type === 'text') {
                    console.info('[BE:WS] Received text message.');
                    if (clientState.ffmpegProcess) {
                        console.info('[BE:FFmpeg] Received text message. Attempting to kill FFmpeg process.');
                        try {
                            process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
                        } catch (e) {
                            console.debug('[BE:FFmpeg] FFmpeg process already finished or not found during text message receive:', e.message);
                        }
                        clientState.ffmpegProcess = null;
                    }
                    if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                    if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();
                    clientState.ffmpegInputStream = null;
                    clientState.pcmOutputStream = null;
                    clientState.isSendingAudioToGemini = false;


                    const content = createUserContent(frontendMessage.message);
                    currentSession.sendClientContent({ turns: [content], turnComplete: true });
                    console.info('[BE:Gemini] Sent text message to Gemini with turnComplete: true.');

                } else if (frontendMessage.type === 'audio' && frontendMessage.audioData) {
                    console.info('[BE:WS] Received audio message (Base64).');
                    const audioBlob = Buffer.from(frontendMessage.audioData, 'base64');
                    console.debug(`[BE:WS] Audio Base64 decoded to ${audioBlob.length} bytes.`);

                    if (clientState.ffmpegProcess) {
                        console.info('[BE:FFmpeg] Received new audio. Attempting to kill previous FFmpeg process.');
                        try {
                            process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
                        } catch (e) {
                            console.debug('[BE:FFmpeg] Previous FFmpeg process already finished or not found:', e.message);
                        }
                        clientState.ffmpegProcess = null;
                    }
                    if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                    if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();


                    const inputStream = new PassThrough();
                    const pcmStream = new PassThrough();

                    clientState.ffmpegInputStream = inputStream;
                    clientState.pcmOutputStream = pcmStream;
                    clientState.isSendingAudioToGemini = false;
                    clientState.firstGeminiResponseReceived = false;
                    clientState.audioBuffer = Buffer.alloc(0);


                    clientState.ffmpegProcess = ffmpeg(inputStream)
                        .inputFormat('webm')
                        .toFormat('s16le')
                        .audioChannels(1)
                        .audioFrequency(24000)
                        .on('start', function (commandLine) {
                            console.info('[BE:FFmpeg] Spawned FFmpeg with command:', commandLine);
                        })
                        .on('error', function (err, stdout, stderr) {
                            console.error('[BE:FFmpeg] Process error:', err.message);
                            console.error('[BE:FFmpeg] FFmpeg stdout:', stdout);
                            console.error('[BE:FFmpeg] FFmpeg stderr:', stderr);

                            if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                            if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();

                            clientState.ffmpegInputStream = null;
                            clientState.ffmpegProcess = null;
                            clientState.pcmOutputStream = null;
                            clientState.isSendingAudioToGemini = false;

                            ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Audio conversion failed: ' + (err.message || 'Unknown FFmpeg error') }));
                        })
                        .on('end', function () {
                            console.info('[BE:FFmpeg] Process finished for current input.');

                            if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                            if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();
                            clientState.ffmpegInputStream = null;
                            clientState.ffmpegProcess = null;
                            clientState.pcmOutputStream = null;

                            console.info('[BE:Gemini] Finished sending audio input stream to Gemini.');
                            clientState.isSendingAudioToGemini = false;


                            try {
                                if (currentSession && currentSession.sendClientContent) {
                                    currentSession.sendClientContent({ turns: [createUserContent('')], turnComplete: true });
                                    console.info('[BE:Gemini] Sent client turnComplete: true signal for audio input.');
                                } else {
                                    console.warn('[BE:Gemini] Cannot send turnComplete: Gemini session not available or closed.');
                                }
                            } catch (signalError) {
                                console.error('[BE:Gemini] Error sending turnComplete signal after audio:', signalError.message);
                                ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error signaling end of audio turn: ' + (signalError.message || 'Unknown signal error') }));
                            }
                            console.info('[BE:Gemini] Waiting for Gemini response...');

                        })
                        .pipe(pcmStream);


                    pcmStream.on('data', (pcmChunk) => {
                        console.debug('[BE:FFmpeg] PCM chunk ready:', pcmChunk.length, 'bytes.');
                        if (currentSession && currentSession.sendRealtimeInput && ws.readyState === WebSocket.OPEN) {
                            try {
                                if (!clientState.isSendingAudioToGemini) {
                                    console.info('[BE:Gemini] Starting to send audio input stream to Gemini.');
                                    clientState.isSendingAudioToGemini = true;
                                }
                                const pcmBase64 = pcmChunk.toString('base64');
                                currentSession.sendRealtimeInput({ audio: { data: pcmBase64, mimeType: 'audio/pcm;rate=24000' } });
                                console.debug('[BE:Gemini] Sent PCM chunk to Gemini.');
                            } catch (geminiError) {
                                console.error('[BE:Gemini] Error sending PCM chunk to Gemini:', geminiError.message);
                                if (clientState.ffmpegProcess) {
                                    try {
                                        process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
                                    } catch (e) { console.debug('[BE:FFmpeg] Error killing process on send error:', e.message); }
                                    clientState.ffmpegProcess = null;
                                }
                                if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                                if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();
                                clientState.ffmpegInputStream = null;
                                clientState.pcmOutputStream = null;
                                clientState.isSendingAudioToGemini = false;


                                ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error sending audio chunk to Gemini: ' + (geminiError.message || 'Unknown Gemini send error') }));
                            }
                        } else {
                            console.warn('[BE:Gemini] Cannot send PCM chunk: WebSocket not open or Gemini session not available.');
                            if (clientState.ffmpegProcess) {
                                try {
                                    process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
                                } catch (e) { console.debug('[BE:FFmpeg] Error killing process on cannot send:', e.message); }
                                clientState.ffmpegProcess = null;
                            }
                            if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                            if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();
                            clientState.ffmpegInputStream = null;
                            clientState.pcmOutputStream = null;
                            clientState.isSendingAudioToGemini = false;

                        }
                    });

                    pcmStream.on('error', (err) => {
                        console.error('[BE:FFmpeg] PCM output stream error:', err.message);
                        if (clientState.ffmpegProcess) {
                            try {
                                process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
                            } catch (e) { console.debug('[BE:FFmpeg] Error killing process on pcm error:', e.message); }
                            clientState.ffmpegProcess = null;
                        }
                        if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
                        if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();
                        clientState.ffmpegInputStream = null;
                        clientState.pcmOutputStream = null;
                        clientState.isSendingAudioToGemini = false;


                        ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Audio output stream error: ' + (err.message || 'Unknown stream error') }));
                    });


                    pcmStream.on('end', () => {
                        console.debug('[BE:FFmpeg] PCM output stream ended.');
                    });


                    inputStream.end(audioBlob);
                    console.debug('[BE:FFmpeg] Fed audio blob to FFmpeg input stream.');


                } else {
                    console.warn('[BE:WS] Received message with unknown type or missing data:', frontendMessage);
                }
            } catch (error) {
                console.error(`[BE:WS] Error processing frontend message: ${error.message}`);
                ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error processing message: ' + (error.message || 'Unknown error') }));
            }
        });

        ws.on('close', (code, reason) => {
            console.info(`[BE:WS] Frontend disconnected. Code: ${code}, Reason: ${reason || 'N/A'}`);
            cleanupClient(ws);
        });

        ws.on('error', (error) => {
            console.error(`[BE:WS] error: ${error.message || 'Unknown error'}`);
            cleanupClient(ws);
        });

    } catch (error) {
        console.error(`[BE:Gemini] FATAL ERROR: Error connecting to Gemini Live: ${error.message || 'Unknown error'}`);
        if (error.stack) console.error('[BE:Gemini] Stack:', error.stack);
        clientStateMap.delete(ws);
        ws.close(1011, 'Backend connection error');
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.info(`[BE:Server] Listening on port ${PORT}`);
    console.info(`[BE:Server] WebSocket server running on ws://localhost:${PORT}`);
});