# Fazoo

Aplicativo de serviços residenciais que conecta clientes a profissionais (ar-condicionado, reparo elétrico, encanamento, construção civil e mais), com orçamentos online e pagamento protegido.

> Status: versão de testes funcional (login, pedidos, orçamentos, chat, avaliação). O pagamento é **simulado**: nenhuma cobrança real é feita.

## Como funciona

1. O cliente se cadastra gratuitamente e publica o serviço que procura.
2. Os profissionais cadastrados veem o pedido e enviam orçamento online.
3. O cliente compara os orçamentos e escolhe.
4. O cliente aceita e paga. O pagamento fica retido na plataforma.
5. Quando o profissional marca como concluído e o cliente confirma, o pagamento é liberado.

## Regras de negócio

- **Comissão:** 10% sobre o valor do serviço, paga pelo cliente por cima do orçamento. Exemplo: orçamento de R$ 3.000 → cliente paga R$ 3.300, R$ 300 ficam com a plataforma e o profissional recebe R$ 3.000.
- **Pagamento retido:** só é liberado quando cliente e profissional confirmam a conclusão.
- **Disputas:** qualquer uma das partes aciona o suporte, que conversa com os dois lados e define a solução (liberação parcial e devolução do restante em serviço incompleto; a comissão continua sendo cobrada). O app já registra o pedido como "em análise"; o painel do suporte ainda não existe.
- **Meio de pagamento:** Mercado Pago. A forma de reter o pagamento ainda será definida; hoje `server/payments.js` simula isso.

## Estrutura

```
public/        Frontend (HTML, CSS e JS puro)
api/index.js   Função da Vercel (recebe /api/* e /health)
server/        Lógica do backend, banco, autenticação e pagamento simulado
test/          Testes automáticos (npm test)
design/        Mockups, tokens de cor
assets/        Logo e ícone
vercel.json    Configuração da Vercel
```

## Publicar na Vercel

Você precisa do projeto em um repositório no GitHub.

1. **Importar:** na Vercel, *Add New → Project*, escolha o repositório `fazoo`. Em *Framework Preset* deixe **Other** e não preencha comando de build.
2. **Banco de dados:** no projeto, aba *Storage* → *Create Database* → **Neon (Postgres)** → conecte ao projeto. Escolha a região mais próxima (São Paulo, se disponível). Isso cria a variável `DATABASE_URL` sozinho. As tabelas são criadas automaticamente no primeiro acesso.
3. **Segredo de login:** em *Settings → Environment Variables*, crie `JWT_SECRET` com um texto longo e aleatório. Para gerar um:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. **Deploy:** clique em *Deploy* (ou *Redeploy* se já tinha feito antes de configurar as variáveis).
5. **Conferir:** abra `https://SEU-PROJETO.vercel.app/health`. Deve aparecer `{"ok":true}`. Se aparecer erro 503, falta `JWT_SECRET` ou `DATABASE_URL`.

Se pedirem login da Vercel ao abrir o site com outras pessoas, desative a proteção em *Settings → Deployment Protection*.

## Rodar localmente

Requer Node 22.

```
npm install
npm start
```

Abre em `http://localhost:3000`. Sem `DATABASE_URL`, usa um arquivo SQLite em `data/fazoo.db`. Testes: `npm test`.

## Antes de usar com dinheiro de verdade

- Integrar o Mercado Pago (retenção, confirmação por webhook, proteção contra cobrança duplicada).
- Recuperação de senha e confirmação de e-mail.
- Upload de fotos, vídeos e áudios dos pedidos.
- Painel do suporte para disputas.
- Limite de tentativas de login compartilhado entre instâncias (hoje é por instância).
- Termos de uso e política de privacidade (LGPD).

## Identidade visual

- **Nome:** Fazoo
- **Logo:** casa azul-marinho com check laranja (`assets/logo-fazoo.svg`, `assets/icone-fazoo.svg`)
- **Cores:** azul-marinho `#12305A` e laranja `#F26B3A` (tokens em `design/tokens.css`)
- **Estilo:** cabeçalho azul, fundo claro, cartões arredondados, avatares e botões em pílula; laranja só na ação principal de cada tela.
- **Mockups:** abra `design/mockups.html` no navegador.
