const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const { createUserContent } = require('@google/genai');
const { Buffer } = require('node:buffer');


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

function stopAudioProcessing(clientState) {
    if (clientState.ffmpegProcess) {
        console.info('[BE:FFmpeg] Attempting to kill FFmpeg process.');
        try {
            process.kill(clientState.ffmpegProcess.pid, 'SIGKILL');
        } catch (e) {
            console.debug('[BE:FFmpeg] FFmpeg process already finished or not found:', e.message);
        }
        clientState.ffmpegProcess = null;
    }
    if (clientState.ffmpegInputStream) clientState.ffmpegInputStream.destroy();
    if (clientState.pcmOutputStream) clientState.pcmOutputStream.destroy();
    clientState.ffmpegInputStream = null;
    clientState.pcmOutputStream = null;
    clientState.isSendingAudioToGemini = false;
}


function cleanupClient(ws, geminiSessionMap, clientStateMap) {
    console.info('[BE:Cleanup] Cleaning up client resources.');
    const clientState = clientStateMap.get(ws);
    if (clientState) {
        console.debug('[BE:Cleanup] Client state found.');
        stopAudioProcessing(clientState);
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

function processGeminiTextPart(ws, part) {
    ws.send(JSON.stringify({ from: 'gemini', type: 'text', data: part.text }));
    console.debug('[BE:WS] Sent text part to frontend.');
}

function processGeminiAudioPart(clientState, part) {
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

function handleGeminiTurnComplete(ws, clientState) {
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

function handleGeminiOpen() {
    console.info('[BE:Gemini] Live session opened');
}

function handleGeminiMessage(ws, liveServerMessage, clientStateMap) {
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
                    processGeminiTextPart(ws, part);
                }
                if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('audio/')) {
                    processGeminiAudioPart(clientState, part);
                }
            });
        }
        if (liveServerMessage.serverContent.turnComplete) {
            handleGeminiTurnComplete(ws, clientState);
        }
    }
}

function handleGeminiError(ws, error) {
    console.error(`[BE:Gemini] Live session error: ${error.message || 'Unknown error'}`);
    if (error.stack) console.error('[BE:Gemini] Stack:', error.stack);
    ws.close(1011, 'Gemini API Error');
}

function handleGeminiClose(closeEvent) {
    console.info(`[BE:Gemini] Live session closed. Code: ${closeEvent.code}, Reason: ${closeEvent.reason || 'N/A'}, WasClean: ${closeEvent.wasClean}`);
}


function sendAudioChunkToGemini(ws, currentSession, clientState, pcmChunk) {
    console.debug('[BE:FFmpeg] PCM chunk ready:', pcmChunk.length, 'bytes.');
    if (currentSession && currentSession.sendRealtimeInput && ws.readyState === 1) {
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
            stopAudioProcessing(clientState);
            ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error sending audio chunk to Gemini: ' + (geminiError.message || 'Unknown Gemini send error') }));
        }
    } else {
        console.warn('[BE:Gemini] Cannot send PCM chunk: WebSocket not open or Gemini session not available.');
        stopAudioProcessing(clientState);
    }
}

function signalAudioEndToGemini(ws, currentSession, clientState) {
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
}


function setupPcmStreamHandlers(ws, currentSession, clientState, pcmStream) {
    pcmStream.on('data', (pcmChunk) => {
        sendAudioChunkToGemini(ws, currentSession, clientState, pcmChunk);
    });

    pcmStream.on('error', (err) => {
        console.error('[BE:FFmpeg] PCM output stream error:', err.message);
        stopAudioProcessing(clientState);
        ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Audio output stream error: ' + (err.message || 'Unknown stream error') }));
    });

    pcmStream.on('end', () => {
        console.debug('[BE:FFmpeg] PCM output stream ended.');
    });
}

function configureFFmpegProcess(ws, currentSession, clientState, inputStream, pcmStream) {
    return ffmpeg(inputStream)
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
            stopAudioProcessing(clientState);
            ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Audio conversion failed: ' + (err.message || 'Unknown FFmpeg error') }));
        })
        .on('end', function () {
            console.info('[BE:FFmpeg] Process finished for current input.');
            signalAudioEndToGemini(ws, currentSession, clientState);
        })
        .pipe(pcmStream);
}

function handleWebSocketMessage(ws, message, geminiSessionMap, clientStateMap) {
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
            handleTextMessage(ws, frontendMessage, geminiSessionMap, clientStateMap);
        } else if (frontendMessage.type === 'audio' && frontendMessage.audioData) {
            handleAudioMessage(ws, frontendMessage, geminiSessionMap, clientStateMap);
        } else {
            console.warn('[BE:WS] Received message with unknown type or missing data:', frontendMessage);
        }
    } catch (error) {
        console.error(`[BE:WS] Error processing frontend message: ${error.message}`);
        ws.send(JSON.stringify({ from: 'backend', type: 'error', data: 'Backend error processing message: ' + (error.message || 'Unknown error') }));
    }
}

function handleTextMessage(ws, frontendMessage, geminiSessionMap, clientStateMap) {
    console.info('[BE:WS] Received text message.');
    const currentSession = geminiSessionMap.get(ws);
    const clientState = clientStateMap.get(ws);

    stopAudioProcessing(clientState);

    const content = createUserContent(frontendMessage.message);
    currentSession.sendClientContent({ turns: [content], turnComplete: true });
    console.info('[BE:Gemini] Sent text message to Gemini with turnComplete: true.');
}


function handleAudioMessage(ws, frontendMessage, geminiSessionMap, clientStateMap) {
    console.info('[BE:WS] Received audio message (Base64).');

    const currentSession = geminiSessionMap.get(ws);
    const clientState = clientStateMap.get(ws);

    const audioBlob = Buffer.from(frontendMessage.audioData, 'base64');
    console.debug(`[BE:WS] Audio Base64 decoded to ${audioBlob.length} bytes.`);

    stopAudioProcessing(clientState);

    clientState.firstGeminiResponseReceived = false;
    clientState.audioBuffer = Buffer.alloc(0);

    const inputStream = new PassThrough();
    const pcmStream = new PassThrough();

    clientState.ffmpegInputStream = inputStream;
    clientState.pcmOutputStream = pcmStream;

    clientState.ffmpegProcess = configureFFmpegProcess(ws, currentSession, clientState, inputStream, pcmStream);
    setupPcmStreamHandlers(ws, currentSession, clientState, pcmStream);

    inputStream.end(audioBlob);
    console.debug('[BE:FFmpeg] Fed audio blob to FFmpeg input stream.');
}

function handleWebSocketClose(ws, code, reason, geminiSessionMap, clientStateMap) {
    console.info(`[BE:WS] Frontend disconnected. Code: ${code}, Reason: ${reason || 'N/A'}`);
    cleanupClient(ws, geminiSessionMap, clientStateMap);
}

function handleWebSocketError(ws, error, geminiSessionMap, clientStateMap) {
    console.error(`[BE:WS] error: ${error.message || 'Unknown error'}`);
    cleanupClient(ws, geminiSessionMap, clientStateMap);
}


module.exports = {
    createWavHeader,
    truncateAudioData,
    cleanupClient,
    processGeminiTextPart,
    processGeminiAudioPart,
    handleGeminiTurnComplete,
    handleGeminiOpen,
    handleGeminiMessage,
    handleGeminiError,
    handleGeminiClose,
    stopAudioProcessing,
    handleTextMessage,
    sendAudioChunkToGemini,
    signalAudioEndToGemini,
    setupPcmStreamHandlers,
    configureFFmpegProcess,
    handleAudioMessage,
    handleWebSocketMessage,
    handleWebSocketClose,
    handleWebSocketError,
};