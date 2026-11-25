# Fazoo

Aplicativo de serviços residenciais que conecta clientes a profissionais (ar-condicionado, reparo elétrico, encanamento, construção civil e mais), com orçamentos online e pagamento protegido.

> Status: fase de design e definição do produto. Ainda sem código.

## Como funciona

1. O cliente se cadastra gratuitamente e publica o serviço que procura, com fotos, vídeos, áudios e informações.
2. Os profissionais cadastrados recebem a notificação, avaliam o pedido e enviam orçamento online.
3. O cliente compara os orçamentos, vê o perfil de cada profissional (portfólio, fotos de serviços e avaliações) e escolhe.
4. O cliente aceita e paga. O pagamento fica retido na plataforma.
5. Quando cliente e profissional confirmam a conclusão, o pagamento é liberado ao profissional.

## Regras de negócio

- **Comissão:** 10% sobre o valor do serviço, paga pelo cliente por cima do orçamento. Exemplo: orçamento de R$ 3.000 → cliente paga R$ 3.300, R$ 300 ficam com a plataforma e o profissional recebe R$ 3.000.
- **Pagamento retido:** só é liberado quando cliente e profissional confirmam a conclusão.
- **Disputas:** qualquer uma das partes aciona o suporte técnico, que conversa com os dois lados e define a melhor solução. Em serviço incompleto, há acordo entre as partes, com liberação de parte do pagamento e devolução do restante. A comissão da plataforma continua sendo cobrada.
- **Meio de pagamento:** Mercado Pago. A forma de implementar a retenção do pagamento será definida na fase de desenvolvimento.
- **Referência de mercado:** GetNinjas, com diferenças (orçamentos online comparáveis e pagamento retido).

## Identidade visual

- **Nome:** Fazoo
- **Logo:** casa azul-marinho com check laranja (`assets/logo-fazoo.svg`, `assets/icone-fazoo.svg`)
- **Cores:** azul-marinho `#12305A` e laranja `#F26B3A` (tokens em `design/tokens.css`)
- **Estilo:** cabeçalho azul, fundo claro, cartões arredondados, avatares e botões em pílula; laranja só na ação principal de cada tela.

## Telas desenhadas

Abra `design/mockups.html` no navegador para ver todas as telas.

Cliente: início, publicar pedido, comparar orçamentos, perfil do profissional, pagamento retido, chat, acompanhar serviço, confirmar conclusão e avaliar.
Profissional: novos pedidos, enviar orçamento, serviço em andamento e recebimentos.
A desenhar: fluxo de disputa (cliente e profissional).
