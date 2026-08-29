# Hyperliquid Live Relay (HIP-3 enabled)

Endpoints:
- `/api/health`
- `/api/quote?coin=SOL`
- `/api/quote?coin=MU`
- `/api/quote?coin=SNDK`
- `/api/quote?coin=SKHX`

The quote endpoint:
1. checks native perps,
2. if not found, enumerates HIP-3 perp DEXes via `perpDexs`,
3. resolves the correct DEX/prefix,
4. fetches `allMids`, `l2Book`, and asset context,
5. returns `live:true` only when the book is sane and fresh (<=10s).
