**To:** Kapruka Tech Team
**Subject:** Bug report — MCP `get_product` returns HTTP 500 for all partner-central (`EF_PC_*`) products

---

Hi Kapruka Tech Team,

We're building an agentic shopping assistant on top of your MCP server (`https://mcp.kapruka.com/mcp`) and have hit a consistent, reproducible server-side failure in the `kapruka_get_product` tool that's blocking product-detail views for a whole class of products.

**Summary**

`kapruka_get_product` returns an upstream error for **every partner-central product** (IDs prefixed `EF_PC_`, images served from `partnercentral.kapruka.com`), while **native-catalog products resolve normally**. The response body is:

```
Error: Kapruka API server error (HTTP 500). Try again later.
```

The failure is 100% reproducible and consistent — it is not transient (retried multiple times over several minutes and across sessions).

**Impact**

These partner products appear normally in `kapruka_search_products` results, so customers can discover them and click into them — but any attempt to load full details fails, so we cannot render a product detail page for them. It affects the entire partner-central catalog, not isolated SKUs.

**Reproduction**

Call `kapruka_get_product` with `response_format: "json"` for the IDs below. We tested a balanced sample of 8 products:

| Product ID | Name | Result |
|---|---|---|
| `SCHOOLPRIDE00154` | Royal College Grey Cap With Gold Logo | ✅ 200 OK |
| `ORNAMENTS00623` | Fantacy Football Table Ornament | ✅ 200 OK |
| `cake00KA001886` | Pink Bloom Ribbon Cake | ✅ 200 OK |
| `fruits00107` | Bananas (Kolikottu) | ✅ 200 OK |
| `EF_PC_HOME0V2033P00056` | Titanic Simulator Toy Wavey Boat | ❌ HTTP 500 |
| `EF_PC_HOME0V18POD00559P` | Scented Artificial Pink Rose Heart Ornament | ❌ HTTP 500 |
| `EF_PC_HOME0V2425P00009` | Coconut Shell Shine Design Turtle Ornament | ❌ HTTP 500 |
| `EF_PC_HOME0V2425P00006` | Coconut Shell Mat Design Elephant Ornament | ❌ HTTP 500 |

Every native ID succeeded; every `EF_PC_*` (partner-central) ID failed with HTTP 500.

**Additional findings**

- The optional `type` hint parameter does **not** work around the issue — we retried a failing `EF_PC_` product with `type` values `"specialgifts"`, `"specialGifts"`, and `"household"`, and all still returned HTTP 500.
- `kapruka_search_products` returns these same `EF_PC_*` products correctly, with full fields (name, price, image, stock, URL). So the search path is healthy; the problem is specific to the product-detail endpoint for partner SKUs.

**What we'd appreciate**

1. Confirmation of the issue on your side for `EF_PC_*` / partner-central products.
2. A fix to the product-detail endpoint so these SKUs resolve, or guidance on any additional parameter required to fetch partner products.
3. An ETA if possible, so we can plan around it in the meantime.

Happy to provide more example IDs, request/response captures, or timestamps from our logs on request.

Thanks very much,
Kavi / Axis Data Tech
