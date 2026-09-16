const BASE = "/api";

export async function listOrders() {
  const res = await fetch(`${BASE}/orders`);
  return res.json();
}