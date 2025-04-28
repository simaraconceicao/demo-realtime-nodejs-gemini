import React, { useState, useEffect, useRef } from 'react';
import { Container, TextField, Button, List, ListItem, ListItemText, Avatar, AppBar, Toolbar, Typography, FormControlLabel } from '@mui/material';
import Box from '@mui/material/Box';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import ChatIcon from '@mui/icons-material/Chat';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AccountCircle, SmartToy, Mic, Stop, Send } from '@mui/icons-material';
import './App.css';

const App = () => {
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [isConnected, setIsConnected] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const socketRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const messagesEndRef = useRef(null);

    const theme = createTheme({
        palette: {
            primary: { main: '#673ab7' },
            secondary: { main: '#7e57c2' },
            background: { default: '#ede7f6' },
        },
        typography: { fontFamily: 'Roboto, sans-serif' },
    });

    const useStyles = {
        chatContainer: { display: 'flex', flexDirection: 'column', height: '93vh' },
        messagesContainer: { flexGrow: 1, overflowY: 'auto', padding: '16px' },
        inputContainer: { padding: '16px', borderTop: '1px solid #ccc', backgroundColor: theme.palette.background.paper },
        listItem: { padding: '8px 16px', borderRadius: '8px', marginBottom: '8px' },
        userMessage: { backgroundColor: '#d1c4e9', alignSelf: 'flex-end' },
        botMessage: { backgroundColor: '#b39ddb', alignSelf: 'flex-start' },
        messageText: { wordBreak: 'break-word' },
        fixedInput: { padding: '10px', backgroundColor: theme.palette.background.default },
    };

    const connectWebSocket = () => {
        socketRef.current = new WebSocket('wss://websocket-node-gemini-service-773267354023.us-central1.run.app');

        socketRef.current.onopen = () => {
            console.log('WebSocket connected');
            setIsConnected(true);
        };

        socketRef.current.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.from === 'gemini') {
                if (data.type === 'text') {
                    setMessages(prev => [...prev, { sender: 'bot', type: 'text', content: data.data }]);
                } else if (data.type === 'audio' && data.data && data.data.audio && data.data.mimeType) {
                    const audioBlob = base64ToBlob(data.data.audio, data.data.mimeType);
                    const audioUrl = URL.createObjectURL(audioBlob);
                    setMessages(prev => [...prev, { sender: 'bot', type: 'audio', content: audioUrl }]);
                }
            }
        };

        socketRef.current.onclose = () => {
            console.log('WebSocket disconnected');
            setIsConnected(false);
        };

        socketRef.current.onerror = (error) => {
            console.error('WebSocket error:', error);
            setIsConnected(false);
        };
    };

    useEffect(() => {
        if (!socketRef.current && isConnected) {
            connectWebSocket();
        }
        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }
        };
    }, [isConnected]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const base64ToBlob = (base64, mime) => {
        const byteChars = atob(base64);
        const byteNumbers = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
            byteNumbers[i] = byteChars.charCodeAt(i);
        }
        return new Blob([byteNumbers], { type: mime });
    };

    const sendMessage = () => {
        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN && newMessage.trim() !== '') {
            socketRef.current.send(JSON.stringify({ type: 'text', message: newMessage }));
            setMessages(prev => [...prev, { sender: 'user', type: 'text', content: newMessage }]);
            setNewMessage('');
        }
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    audioChunksRef.current.push(e.data);
                }
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current.mimeType });
                const audioUrl = URL.createObjectURL(audioBlob);
                setMessages(prev => [...prev, { sender: 'user', type: 'audio', content: audioUrl }]);

                if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const base64data = reader.result.split(',')[1];
                        socketRef.current.send(JSON.stringify({ type: 'audio', audioData: base64data }));
                    };
                    reader.onerror = (error) => {
                        console.error('FileReader error:', error);
                    };
                    reader.readAsDataURL(audioBlob);
                }

                audioChunksRef.current = [];
                setIsRecording(false);
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (error) {
            console.error('Error starting recording:', error);
            setIsRecording(false);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
    };

    const handleToggleConnection = () => {
        setIsConnected(prev => !prev);
        if (socketRef.current) {
            socketRef.current.close();
            socketRef.current = null;
        }
        if (isRecording) {
            stopRecording();
        }
    };

    useEffect(() => {
        const urlsToRevoke = [];
        messages.forEach(msg => {
            if (msg.type === 'audio' && msg.content.startsWith('blob:')) {
                urlsToRevoke.push(msg.content);
            }
        });
        return () => {
            urlsToRevoke.forEach(url => URL.revokeObjectURL(url));
        };
    }, [messages]);

    return (
        <ThemeProvider theme={theme}>
            <AppBar position="static">
                <Toolbar>
                    <ChatIcon sx={{ mr: 2 }} />
                    <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                        Realtime com Gemini
                    </Typography>
                    <FormControlLabel
                        control={<PowerSettingsNewIcon onClick={handleToggleConnection} />}
                        aria-label={isConnected ? "Desconectar" : "Conectar"}
                        label={isConnected ? "Desconectar" : "Conectar"}
                        style={{ color: isConnected ? "pink" : "#33c9dc" }}
                    />
                </Toolbar>
            </AppBar>

            <Container maxWidth="md" style={useStyles.chatContainer}>
                <Box sx={useStyles.messagesContainer}>
                    <List>
                        {messages.map((message, index) => (
                            <ListItem
                                key={index}
                                alignItems="flex-start"
                                style={{
                                    ...useStyles.listItem,
                                    ...(message.sender === 'user' ? useStyles.userMessage : useStyles.botMessage),
                                }}
                            >
                                <Avatar sx={{ mr: 2 }}>
                                    {message.sender === 'user' ? <AccountCircle /> : <SmartToy />}
                                </Avatar>
                                <ListItemText
                                    primary={message.sender === 'user' ? "Você:" : "Gemini:"}
                                    secondary={
                                        message.type === 'text' ? (
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                                        ) : (
                                            <audio controls src={message.content} />
                                        )
                                    }
                                />
                            </ListItem>
                        ))}
                        <div ref={messagesEndRef} />
                    </List>
                </Box>

                <Box sx={useStyles.fixedInput}>
                    <TextField
                        fullWidth
                        label="Digite sua mensagem"
                        variant="outlined"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        onKeyPress={(e) => { if (e.key === 'Enter') sendMessage(); }}
                        style={{ marginBottom: '1rem' }}
                    />
                    <Button variant="contained" color="secondary" onClick={sendMessage} sx={{ mr: 1 }}>
                        <Send /> Enviar Texto
                    </Button>
                    {isRecording ? (
                        <Button variant="contained" color="secondary" onClick={stopRecording}>
                            <Stop /> Parar Gravação
                        </Button>
                    ) : (
                        <Button variant="contained" color="secondary" onClick={startRecording}>
                            <Mic /> Gravar Áudio
                        </Button>
                    )}
                </Box>
            </Container>
        </ThemeProvider>
    );
};

export default App;
