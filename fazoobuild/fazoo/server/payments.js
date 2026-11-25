import { randomUUID } from "node:crypto";

// Provedor de pagamento SIMULADO. Nenhuma cobrança real é feita.
// Para usar o Mercado Pago, troque a implementação destas 3 funções mantendo a mesma assinatura.
// Antes disso é preciso definir e validar, na documentação oficial do Mercado Pago, como será
// a retenção do pagamento até a confirmação de conclusão. Um provedor real também exige
// confirmação por webhook e proteção contra cobrança duplicada (idempotência).
export const pagamentos = {
  async reter({ pedidoId, totalCentavos }) {
    return { ref: "sim_" + randomUUID(), status: "retido", pedidoId, totalCentavos };
  },
  async liberar({ ref }) {
    return { ref, status: "liberado" };
  },
  async reembolsar({ ref }) {
    return { ref, status: "reembolsado" };
  },
};
