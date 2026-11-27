// Cidades e distâncias. Cada usuário e cada pedido guardam o código IBGE da cidade;
// a distância é calculada entre os centros das cidades (em linha reta).
import CIDADES from "./cidades-dados.js";

export const RAIOS = [0, 10, 25, 50, 100]; // km; 0 = só na mesma cidade

export function cidade(id) {
  const c = CIDADES[Number(id)];
  return c ? { id: Number(id), nome: c[0], uf: c[1] } : null;
}

export const nomeCidade = (id) => {
  const c = cidade(id);
  return c ? `${c.nome} - ${c.uf}` : "";
};

// Distância em km entre duas cidades (fórmula de Haversine). null se alguma não existir.
export function distanciaKm(a, b) {
  if (a == null || b == null) return null;
  if (Number(a) === Number(b)) return 0;
  const x = CIDADES[Number(a)], y = CIDADES[Number(b)];
  if (!x || !y) return null;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(y[2] - x[2]), dLon = rad(y[3] - x[3]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(x[2])) * Math.cos(rad(y[2])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

// O pedido chega até a cidade? (raio 0 = só a mesma cidade)
export function dentroDoRaio(cidadePedido, raio, outraCidade) {
  if (cidadePedido == null) return true; // pedidos antigos, sem cidade, aparecem para todos
  const d = distanciaKm(cidadePedido, outraCidade);
  return d != null && d <= (raio || 0);
}
