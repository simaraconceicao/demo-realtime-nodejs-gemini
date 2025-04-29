import React, { useState, useEffect, useRef } from 'react';
import {
    Container,
    TextField,
    Button,
    List,
    ListItem,
    ListItemText,
    Avatar,
    AppBar,
    Toolbar,
    Typography,
    Box,
    FormControlLabel,
    IconButton
} from '@mui/material';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import ChatIcon from '@mui/icons-material/Chat';
import { createTheme, ThemeProvider, styled } from '@mui/material/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AccountCircle, SmartToy, Mic, Stop, Send } from '@mui/icons-material';
import './App.css';

const theme = createTheme({
    palette: {
        primary: { main: '#673ab7' },
        secondary: { main: '#7e57c2' },
        background: { default: '#ede7f6', paper: '#f3e5f5' },
        success: { main: '#4caf50' },
        error: { main: '#f44336' },
    },
    typography: { fontFamily: 'Roboto, sans-serif' },
    components: {
        MuiListItem: {
            styleOverrides: {
                root: {
                    marginBottom: '8px',
                    borderRadius: '15px',
                    padding: '10px 15px',
                    maxWidth: '80%',
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                    display: 'flex',
                    alignItems: 'flex-start',
                    boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)',
                },
            },
        },
        MuiTextField: {
            styleOverrides: {
                root: {
                    '& label.Mui-focused': {
                        color: '#673ab7',
                    },
                    '& .MuiOutlinedInput-root': {
                        '& fieldset': {
                            borderColor: '#d1c4e9',
                        },
                        '&:hover fieldset': {
                            borderColor: '#b39ddb',
                        },
                        '&.Mui-focused fieldset': {
                            borderColor: '#673ab7',
                        },
                        borderRadius: '20px',
                        paddingRight: '8px',
                    },
                    '& .MuiInputBase-input': {
                        padding: '14px',
                    },
                    '& .MuiInputLabel-outlined': {
                        transform: 'translate(14px, 14px) scale(1)',
                        '&.Mui-focused': {
                            transform: 'translate(14px, -9px) scale(0.75)',
                        },
                        '&.MuiFormLabel-filled': {
                            transform: 'translate(14px, -9px) scale(0.75)',
                        },
                    }
                },
            },
        },
        MuiButton: {
            styleOverrides: {
                root: {
                    borderRadius: '20px',
                    padding: '14px 24px',
                    minWidth: 'auto',
                },
                containedSecondary: {
                    backgroundColor: '#7e57c2',
                    '&:hover': {
                        backgroundColor: '#673ab7',
                    },
                },
            },
        },
        MuiAppBar: {
            styleOverrides: {
                colorPrimary: {
                    backgroundColor: '#5e35b1',
                },
            },
        },
        MuiAvatar: {
            styleOverrides: {
                root: {
                    width: 32,
                    height: 32,
                }
            }
        }
    },
});

const StyledListItem = styled(ListItem)(({ theme, sender }) => ({
    backgroundColor: sender === 'user' ? theme.palette.secondary.light : theme.palette.primary.light,
    alignSelf: sender === 'user' ? 'flex-end' : 'flex-start',
    marginLeft: sender === 'user' ? 'auto' : '0',
    marginRight: sender === 'bot' ? 'auto' : '0',
    flexDirection: sender === 'user' ? 'row-reverse' : 'row',
}));


const App = () => {
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [isConnected, setIsConnected] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const socketRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const messagesEndRef = useRef(null);
    const userAudioChunksRef = useRef([]);


    const connectWebSocket = () => {
        if (socketRef.current && socketRef.current.readyState !== WebSocket.CLOSED) {
            return;
        }

        const wsUrl = 'wss://websocket-node-gemini-service-773267354023.us-central1.run.app';
        socketRef.current = new WebSocket(wsUrl);

        socketRef.current.onopen = () => {
            setIsConnected(true);
        };

        socketRef.current.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.from === 'gemini') {
                    setMessages(prev => {
                        const updatedMessages = [...prev];
                        const lastBotMessageIndex = updatedMessages.findLastIndex(msg => msg.sender === 'bot');
                        const lastBotTextMessageIndex = updatedMessages.findLastIndex(msg => msg.sender === 'bot' && msg.type === 'text');

                        if (data.type === 'text') {
                            if (lastBotTextMessageIndex !== -1 && !updatedMessages[lastBotTextMessageIndex].turnComplete) {
                                updatedMessages[lastBotTextMessageIndex].content += data.data;
                            } else {
                                if (lastBotMessageIndex !== -1 && !updatedMessages[lastBotMessageIndex].turnComplete) {
                                    updatedMessages[lastBotMessageIndex].turnComplete = true;
                                }
                                updatedMessages.push({ sender: 'bot', type: 'text', content: data.data, turnComplete: false });
                            }
                        } else if (data.type === 'audio' && data.data && data.data.audio && data.data.mimeType) {
                            const audioBlob = base64ToBlob(data.data.audio, data.data.mimeType);
                            if (audioBlob) {
                                const audioUrl = URL.createObjectURL(audioBlob);
                                if (lastBotMessageIndex !== -1 && !updatedMessages[lastBotMessageIndex].turnComplete) {
                                    updatedMessages[lastBotMessageIndex].turnComplete = true;
                                }
                                updatedMessages.push({ sender: 'bot', type: 'audio', content: audioUrl, turnComplete: true });
                            }
                        } else if (data.type === 'turnComplete') {
                            if (lastBotMessageIndex !== -1 && !updatedMessages[lastBotMessageIndex].turnComplete) {
                                updatedMessages[lastBotMessageIndex].turnComplete = true;
                            }
                        }

                        return updatedMessages;
                    });
                } else if (data.from === 'backend' && data.type === 'error') {
                    setMessages(prev => [...prev, { sender: 'bot', type: 'text', content: `Erro do Backend: ${data.data}`, isError: true, turnComplete: true }]);
                }
            } catch (error) {
                setMessages(prev => [...prev, { sender: 'bot', type: 'text', content: `Erro ao processar mensagem: ${error.message}`, isError: true, turnComplete: true }]);
            }
        };


        socketRef.current.onclose = (event) => {
            setIsConnected(false);
            if (isRecording) {
                stopRecording();
            }
        };

        socketRef.current.onerror = (error) => {
            setIsConnected(false);
            if (isRecording) {
                stopRecording();
            }
        };
    };

    const disconnectWebSocket = () => {
        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            socketRef.current.close(1000, 'User initiated disconnect');
        } else {
            setIsConnected(false);
        }
        if (isRecording) {
            stopRecording();
        }
        socketRef.current = null;
    };

    useEffect(() => {
        return () => {
            if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                socketRef.current.close(1001, 'Component cleanup');
            }
            socketRef.current = null;
            if (mediaRecorderRef.current?.stream) {
                mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
            }
        };
    }, []);


    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    useEffect(() => {
        return () => {
            messages.forEach(msg => {
                if (msg.type === 'audio' && msg.content && msg.content.startsWith('blob:')) {
                    URL.revokeObjectURL(msg.content);
                }
            });
        };
    }, [messages]);

    const base64ToBlob = (base64, mime) => {
        try {
            const byteChars = atob(base64);
            const byteNumbers = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
                byteNumbers[i] = byteChars.charCodeAt(i);
            }
            const blob = new Blob([byteNumbers], { type: mime });
            return blob;
        } catch (error) {
            return null;
        }
    };

    const sendMessage = () => {
        if (!isConnected || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
            return;
        }
        if (newMessage.trim() === '') {
            return;
        }

        const messageToSend = newMessage.trim();
        try {
            socketRef.current.send(JSON.stringify({ type: 'text', message: messageToSend }));
            setMessages(prev => [...prev, { sender: 'user', type: 'text', content: messageToSend, turnComplete: true }]);
            setNewMessage('');
        } catch (error) {
        }
    };

    const startRecording = async () => {
        if (!isConnected || (socketRef.current && socketRef.current.readyState !== WebSocket.OPEN)) {
            return;
        }
        if (isRecording) {
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            userAudioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    userAudioChunksRef.current.push(e.data);
                }
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(userAudioChunksRef.current, { type: mediaRecorderRef.current.mimeType });
                const audioUrl = URL.createObjectURL(audioBlob);

                setMessages(prev => [...prev, { sender: 'user', type: 'audio', content: audioUrl, turnComplete: true }]);


                if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const base64data = reader.result.split(',')[1];
                        try {
                            socketRef.current.send(JSON.stringify({ type: 'audio', audioData: base64data }));
                        } catch (error) {
                        }
                    };
                    reader.onerror = (error) => {
                    };
                    reader.readAsDataURL(audioBlob);
                }


                userAudioChunksRef.current = [];
                stream.getTracks().forEach(track => track.stop());
                setIsRecording(false);
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);


        } catch (error) {
            setIsRecording(false);
            setMessages(prev => [...prev, { sender: 'bot', type: 'text', content: `Erro ao iniciar gravação: ${error.message}`, isError: true, turnComplete: true }]);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        } else {
            setIsRecording(false);
        }
    };

    const handleToggleConnection = () => {
        if (isConnected) {
            disconnectWebSocket();
        } else {
            connectWebSocket();
        }
    };

    return (
        <ThemeProvider theme={theme}>
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: theme.palette.background.default }}>
                <AppBar position="static">
                    <Toolbar>
                        <ChatIcon sx={{ mr: 2 }} />
                        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                            Realtime com Gemini
                        </Typography>
                        <FormControlLabel
                            control={
                                <IconButton
                                    color="inherit"
                                    aria-label={isConnected ? "Desconectar" : "Conectar"}
                                    title={isConnected ? "Desconectar" : "Conectar"}
                                    onClick={handleToggleConnection}
                                >
                                    <PowerSettingsNewIcon />
                                </IconButton>
                            }
                            label={isConnected ? "Online" : "Offline"}
                            sx={{
                                marginRight: 0,
                                color: isConnected ? theme.palette.success.main : theme.palette.error.main,
                                '.MuiFormControlLabel-label': {
                                    color: isConnected ? theme.palette.success.main : theme.palette.error.main,
                                    fontWeight: 'bold'
                                }
                            }}
                        />
                    </Toolbar>
                </AppBar>

                <Container maxWidth="md" sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflowY: 'hidden', paddingBottom: 0 }}>
                    <Box sx={{ flexGrow: 1, overflowY: 'auto', padding: '16px', mt: 2, '& > ul': { listStyle: 'none', padding: 0 } }}>
                        <List>
                            {messages.map((message, index) => (
                                <StyledListItem
                                    key={index}
                                    sender={message.sender}
                                >
                                    <Avatar sx={{ mr: message.sender === 'user' ? 0 : 2, ml: message.sender === 'user' ? 2 : 0, bgcolor: message.sender === 'user' ? theme.palette.secondary.dark : theme.palette.primary.dark }}>
                                        {message.sender === 'user' ? <AccountCircle /> : <SmartToy />}
                                    </Avatar>
                                    <ListItemText
                                        primary={message.sender === 'user' ? "Você:" : "Gemini:"}
                                        secondary={
                                            message.type === 'text' ? (
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        p: ({ node, ...props }) => <div style={{ margin: 0 }} {...props} />,
                                                    }}
                                                >
                                                    {message.content}
                                                </ReactMarkdown>
                                            ) : message.type === 'audio' ? (
                                                <audio controls src={message.content} />
                                            ) : null
                                        }
                                        sx={{ '& .MuiListItemText-primary': { fontWeight: 'bold' } }}
                                    />
                                </StyledListItem>
                            ))}
                            <div ref={messagesEndRef} />
                        </List>
                    </Box>

                    <Box sx={{ padding: '16px', borderTop: '1px solid #ccc', backgroundColor: theme.palette.background.paper, display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <TextField
                            fullWidth
                            label="Digite sua mensagem"
                            variant="outlined"
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onKeyPress={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } }}
                            disabled={!isConnected || isRecording}
                            sx={{ flexGrow: 1 }}
                        />
                        <Button
                            variant="contained"
                            color="secondary"
                            onClick={sendMessage}
                            disabled={!isConnected || newMessage.trim() === '' || isRecording}
                        >
                            <Send />
                        </Button>
                        {isRecording ? (
                            <Button
                                variant="contained"
                                color="secondary"
                                onClick={stopRecording}
                                disabled={!isConnected}
                            >
                                <Stop /> Parar
                            </Button>
                        ) : (
                            <Button
                                variant="contained"
                                color="secondary"
                                onClick={startRecording}
                                disabled={!isConnected || !!newMessage.trim()}
                            >
                                <Mic /> Gravar
                            </Button>
                        )}
                    </Box>
                </Container>
            </Box>
        </ThemeProvider>
    );
};

export default App;