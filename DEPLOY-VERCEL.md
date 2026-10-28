# Deixar no Vercel (site) + Render (servidor)

O Vercel hospeda a página. O servidor (chat e sinalização das chamadas) precisa de
WebSocket, que o Vercel não suporta, então ele roda no Render (grátis).

## Passo 1 — Servidor no Render

1. Suba esta pasta inteira para um repositório no GitHub.
2. Render > New > Web Service > escolha o repositório.
   - Build command: `npm install`
   - Start command: `npm start`
   - Plano: Free
3. Quando estiver no ar, copie o link, algo como `https://meu-discord-server.onrender.com`.
   Teste abrindo `SEU_LINK/health` (deve mostrar "ok").

## Passo 2 — Site no Vercel

1. Edite `public/config.js` e coloque o link do Render:
   ```js
   window.SERVER_URL = 'https://meu-discord-server.onrender.com';
   ```
2. Faça commit/push no GitHub.
3. Vercel > Add New > Project > importe o mesmo repositório.
   - Framework Preset: Other
   - Não precisa de build. O `vercel.json` já aponta para a pasta `public`.
4. Deploy. Seu link será `https://seu-projeto.vercel.app`.

## Passo 3 — Liberar o site no servidor (recomendado)

No Render > Environment, crie a variável:

```
ALLOWED_ORIGIN = https://seu-projeto.vercel.app
```

Salve e deixe reiniciar. (Sem isso o servidor aceita qualquer site.)

## Observações

- O plano grátis do Render "dorme" após ~15 min sem uso; a primeira conexão pode levar cerca de 30 s.
  Para não dormir, use um plano pago ou um serviço que faça ping em `/health`.
- Câmera, mic e tela funcionam porque o Vercel já entrega HTTPS.
- Se algum amigo não conectar na chamada (4G/rede restrita), configure um servidor TURN em `public/app.js` (const ICE).
