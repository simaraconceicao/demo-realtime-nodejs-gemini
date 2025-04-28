# 🚀 Seu Chat Realtime com Gemini

Este repositório contém um backend e um frontend configurados para rodar no **Google Cloud Run**, utilizando **NodeJs**, **WebSockets** e **Gemini**. Essas tecnologias formam uma stack moderna, com foco em escalabilidade, performance e flexibilidade, permitindo criar aplicações robustas, de alta performance e fáceis de manter.

---

## 📌 Tecnologias Utilizadas

### **Backend**
- **NodeJS**
- **express**
- **WebSockets**
- **Gemini**
- **Docker**
- **Google Cloud Run**
- **Uvicorn**

### **Frontend**
- **Node.js**
- **ReactJS**
- **Nginx**
- **Docker**
- **Google Cloud Run**

---

## 🏗️ Processo de Deploy no Cloud Run

### **Backend**

O backend foi desenvolvido em **NodeJS (Express)** e utiliza **WebSockets** para comunicação em tempo real com a API **Gemini**.

### **1️⃣ Dockerfile**

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci

RUN apt-get update && apt-get install -y ffmpeg

COPY . .

CMD ["npm", "start"]
```

### **2️⃣ Deploy no Cloud Run**

```sh
gcloud run deploy websocket-node-gemini-service \
  --source . \
  --platform managed \
  --region $GOOGLE_CLOUD_LOCATION \
  --project $GOOGLE_CLOUD_PROJECT \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT,GOOGLE_CLOUD_LOCATION=$GOOGLE_CLOUD_LOCATION,GEMINI_API_KEY=$GEMINI_API_KEY" \
  --timeout=3600
```

---

### **Frontend**

O frontend está configurado para ser servido com **Nginx**.

### **1️⃣ Dockerfile**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### **2️⃣  Deploy no Cloud Run**

```sh
cloud run deploy front-react-websocket \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 80
```

---

## ⚡ WebSockets e Integração com Gemini

### **O que são WebSockets?**
WebSockets são uma tecnologia que permite **comunicação bidirecional** em tempo real entre o cliente e o servidor, diferente de requisições HTTP convencionais que são unidirecionais.

### **Por que usar WebSockets com Gemini?**
- **Baixa latência**: Permite comunicação instantânea sem a necessidade de polling.
- **Histórico mantido**: Durante a conexão, o chat mantém o contexto da conversa.
- **Tempo de conexão**: A sessão WebSocket dura **15 minutos** antes de ser encerrada automaticamente.

### **Fluxo de Comunicação**
1. O usuário se conecta ao WebSocket clicando no botão **conectar**.
2. O backend estabelece uma sessão com **Gemini**.
3. As mensagens enviadas pelo usuário são processadas e enviadas para a IA.
4. A IA responde e a resposta é enviada de volta ao cliente.

---

## 🔗 Referências
- [Google Cloud Run](https://cloud.google.com/run)
- [@gogle/genai)](https://googleapis.github.io/js-genai/main/classes/live.Live.html)

---

Agora é só fazer o deploy e testar o WebSocket! 🚀

