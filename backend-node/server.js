require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI } = require('@google/genai');
const { Buffer } = require('node:buffer');

const utils = require('./utils');

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

async function handleNewConnection(ws) {
    console.info('[BE:WS] Frontend connected');
    clientStateMap.set(ws, {
        audioBuffer: Buffer.alloc(0),
        mimeType: '',
        ffmpegInputStream: null,
        ffmpegProcess: null,
        pcmOutputStream: null,
        isSendingAudioToGemini: false,
        firstGeminiResponseReceived: false
    });

    const connectParams = {
        model: 'gemini-2.0-flash-live-001',
        callbacks: {
            onopen: () => utils.handleGeminiOpen(),
            onmessage: (liveServerMessage) => utils.handleGeminiMessage(ws, liveServerMessage, clientStateMap),
            onerror: (error) => utils.handleGeminiError(ws, error),
            onclose: (closeEvent) => utils.handleGeminiClose(closeEvent)
        },
        config: {
            systemInstruction: "You are a Google Cloud Platform specialist."
        }
    };

    try {
        const session = await ai.live.connect(connectParams);
        geminiSessionMap.set(ws, session);
        console.info('[BE:Gemini] Live session connected for client.');

        ws.on('message', (message) => utils.handleWebSocketMessage(ws, message, geminiSessionMap, clientStateMap));
        ws.on('close', (code, reason) => utils.handleWebSocketClose(ws, code, reason, geminiSessionMap, clientStateMap));
        ws.on('error', (error) => utils.handleWebSocketError(ws, error, geminiSessionMap, clientStateMap));

    } catch (error) {
        console.error(`[BE:Gemini] FATAL ERROR: Error connecting to Gemini Live: ${error.message || 'Unknown error'}`);
        if (error.stack) console.error('[BE:Gemini] Stack:', error.stack);
        clientStateMap.delete(ws);
        ws.close(1011, 'Backend connection error');
    }
}


wss.on('connection', handleNewConnection);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.info(`[BE:Server] Listening on port ${PORT}`);
    console.info(`[BE:Server] WebSocket server running on ws://localhost:${PORT}`);
});