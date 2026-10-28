# Meu Discord (chat + voz + câmera + tela no navegador)

App próprio em Node.js + Socket.IO + WebRTC. Seus amigos só abrem o link no navegador.

## Rodar no seu PC

```bash
npm install
npm start
```

Abra http://localhost:3000

## Deixar online para os amigos

Câmera, microfone e tela só funcionam em **HTTPS** (ou localhost).

### Opção A — do seu PC, grátis, na hora (Cloudflare Tunnel)

1. Instale o `cloudflared` (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. Com o app rodando (`npm start`), em outro terminal:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Ele mostra um link `https://xxxx.trycloudflare.com` — mande pros amigos.
   O PC precisa ficar ligado com o app aberto.

### Opção B — hospedagem 24h (Render, Railway, Fly.io)

1. Suba esta pasta num repositório do GitHub.
2. No Render: New > Web Service > selecione o repositório.
   - Build command: `npm install`
   - Start command: `npm start`
3. O link `https://seu-app.onrender.com` já vem com HTTPS.
   (O plano grátis "dorme" após inatividade e demora um pouco para acordar.)

## Limites

- Chamada em malha (mesh): cada pessoa se conecta direto com todas as outras. Funciona bem até ~6 pessoas por sala.
  Para salas maiores seria preciso um SFU (LiveKit, mediasoup).
- Se alguém não conseguir conectar (4G/redes restritas), configure um servidor TURN em `public/app.js` (const ICE).
- Sem contas, senhas nem banco de dados: o histórico do chat fica só na memória do servidor.
