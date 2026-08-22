### Name: kapruka_get_product

Description: Fetch full details for a single Kapruka product by its product ID.

| Parameter         | Type                | Required | Default      | Description                                                |
| ----------------- | ------------------- | -------- | ------------ | ---------------------------------------------------------- |
| `product_id`      | string (3-80 chars) | **Yes**  | —            | Product ID (e.g. `"cake00ka002034"`)                       |
| `currency`        | string              | No       | `"LKR"`      | `LKR`, `USD`, `GBP`, `AUD`, `CAD`, `EUR`                   |
| `type`            | string \| null      | No       | `null`       | Optional type hint (e.g. `"specialgifts"`) — rarely needed |
| `response_format` | string              | No       | `"markdown"` | `"markdown"` or `"json"`                                   |

- Get the `product_id` from search results
- IDs starting with `CATSYM` are category pages, not real products
- Use `"json"` format to extract image URLs, variants, and stock levels


	    Returns name, description, price (with optional currency conversion), stock status,
	  images, variants, shipping info, and a direct product URL.

	    Note: Some IDs starting with 'CATSYM' are category landing pages, not purchasable
    products — this tool will flag those clearly.

    Args:
        params (GetProductInput):
            - product_id (str): Kapruka product ID (e.g. 'cake00ka002034')
            - currency (str): Price currency — LKR (default), USD, GBP, AUD, CAD, EUR
            - type (Optional[str]): Optional type hint (e.g. 'specialgifts')
            - response_format (str): 'markdown' (default) or 'json'

    Returns:
        str: Product details in the requested format.

        JSON schema:
        {
          "id": str,
          "name": str,
          "description": str,
          "summary": str,
          "price": {"amount": float, "currency": str},
          "compare_at_price": {"amount": float, "currency": str} | null,
          "in_stock": bool,
          "stock_level": str,           # "low" | "medium" | "high"
          "category": {"id": str, "name": str, "slug": str, "path": str},
          "variants": [{"id": str, "name": str, "sku": str, "price": {...},
                        "in_stock": bool, "stock_level": str, "attributes": {...}}],
          "images": [str],              # list of full-resolution image URLs
          "attributes": {"type": str, "subtype": str, "weight": str, "vendor": str},
          "shipping": {"ships_from": str, "ships_internationally": bool, "restricted_countries": [str]},
          "rating": null,
          "url": str
        }

        Error: "Error: <message>" on failure.
    
### Name: kapruka_search_products

Description: Search for products on Kapruka.com by keyword, with optional category filter and pagination.

| Parameter         | Type                 | Required | Default       | Description                                                              |
| ----------------- | -------------------- | -------- | ------------- | ------------------------------------------------------------------------ |
| `q`               | string (3-200 chars) | **Yes**  | —             | Search query (e.g. `"birthday cake"`)                                    |
| `category`        | string \| null       | No       | `null`        | Top-level category filter (e.g. `"Chocolates"`, case-insensitive)        |
| `limit`           | int (1-50)           | No       | `10`          | Results per page                                                         |
| `cursor`          | string \| null       | No       | `null`        | Pagination cursor from previous response                                 |
| `currency`        | string               | No       | `"LKR"`       | `LKR`, `USD`, `GBP`, `AUD`, `CAD`, `EUR`                                 |
| `min_price`       | number \| null       | No       | `null`        | Min price filter (inclusive)                                             |
| `max_price`       | number \| null       | No       | `null`        | Max price filter (inclusive)                                             |
| `in_stock_only`   | bool                 | No       | `false`       | Only return in-stock items                                               |
| `sort`            | string               | No       | `"relevance"` | `"relevance"`, `"price_asc"`, `"price_desc"`, `"newest"`, `"bestseller"` |
| `include_stubs`   | bool                 | No       | `false`       | Include category landing pages (price=0)                                 |
| `response_format` | string               | No       | `"markdown"`  | `"markdown"` or `"json"`                                                 |

**💡 Tips:**

- Always set `in_stock_only: true` if you intend to create an order
- Use `response_format: "json"` to parse product IDs programmatically
- Max 3 pages of pagination per query — refine with `category`/price filters instead
- `q` must have specific terms (not just stopwords like "the", "a")



    Returns a ranked list of matching products with prices, stock status, images, and URLs.
    Supports cursor-based pagination — pass next_cursor from one response into the next call.
    Pagination is capped at 3 pages per query to discourage catalog enumeration; for broader
    discovery, refine the query or filter by category instead.

    Queries must be at least 3 characters and contain specific terms — pure stopword queries
    (e.g. "the", "a an") are rejected.

    By default, category landing pages (CATSYM entries with price=0) are filtered out so results
    contain only purchasable products. Set include_stubs=true to include them.

    Args:
        params (SearchProductsInput):
            - q (str): Search query (e.g. 'birthday cake', 'roses', 'tea gift'). Min 3 chars.
            - category (Optional[str]): Category filter (e.g. 'Birthday', 'Flowers')
            - limit (int): Results per page, 1–50 (default 10)
            - cursor (Optional[str]): Pagination cursor from previous response
            - currency (str): LKR (default), USD, GBP, AUD, CAD, EUR
            - min_price (Optional[float]): Min price (inclusive) in the requested currency
            - max_price (Optional[float]): Max price (inclusive) in the requested currency
            - in_stock_only (bool): Restrict to in-stock items (default false)
            - sort (str): 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'bestseller'
            - include_stubs (bool): Include category landing pages (default false)
            - response_format (str): 'markdown' (default) or 'json'

    Returns:
        str: Search results in the requested format.

        JSON schema:
        {
          "results": [
            {
              "id": str,
              "name": str,
              "summary": str,
              "price": {"amount": float | null, "currency": str},
              "compare_at_price": {"amount": float, "currency": str} | null,
              "in_stock": bool,
              "stock_level": str,
              "image_url": str | null,
              "category": {"id": str, "name": str, "slug": str},
              "rating": null,
              "ships_internationally": bool,
              "url": str
            }
          ],
          "next_cursor": str | null,    # null after page 3 even if upstream has more
          "applied_filters": {"q": str, "limit": int, "in_stock_only": bool}
        }

        Error: "Error: <message>" or "No products found for '<query>'" on failure.
    
### Name: kapruka_list_delivery_cities

Description: List or search Sri Lankan cities Kapruka delivers to.

|Parameter|Type|Required|Default|Description|
|---|---|---|---|---|
|`query`|string \| null (max 50)|No|`null`|Partial match filter (e.g. `"colombo"`, `"gall"`)|
|`limit`|int (1-50)|No|`25`|Max results|
|`response_format`|string|No|`"markdown"`|`"markdown"` or `"json"`|

- **Always pass a `query`** — without one, you just get the first 25 alphabetically
- Use `"json"` to get canonical city names + aliases
- The returned `name` is what you pass to `check_delivery` and `create_order`




    Use the `query` param to filter (e.g. "colombo" → all Colombo zones,
    "anur" → Anuradhapura). Without a query you get the first 25 cities
    alphabetically, which is rarely what an agent needs — pass a query.

    Returns canonical city names (use these as the `city` argument to
    kapruka_check_delivery) plus any common aliases / vernacular spellings.

    Args:
        params (ListDeliveryCitiesInput):
            - query (Optional[str]): Partial match filter
            - limit (int): Max results, 1–50 (default 25)
            - response_format (str): 'markdown' (default) or 'json'

    Returns:
        str: Cities list in the requested format.

        JSON schema:
        {
          "cities": [{"name": str, "aliases": [str]}],
          "total_matched": int,
          "showing": int
        }
    
### Name: kapruka_check_delivery

Description: Check whether Kapruka can deliver to a given city on a given date, and at what rate.

- Always call `list_delivery_cities` first to get the exact canonical city name
- Pass `product_id` for cakes/flowers to get freshness warnings
- Use `"json"` to check the `available` boolean and `rate` programmatically

| Parameter         | Type                 | Required | Default        | Description                                         |
| ----------------- | -------------------- | -------- | -------------- | --------------------------------------------------- |
| `city`            | string (2-100 chars) | **Yes**  | —              | Canonical city name from `list_delivery_cities`     |
| `delivery_date`   | string \| null       | No       | `null` (today) | Target date in `YYYY-MM-DD` (Sri Lanka time)        |
| `product_id`      | string \| null       | No       | `null`         | Enables perishable warning for cakes/flowers/combos |
| `response_format` | string               | No       | `"markdown"`   | `"markdown"` or `"json"`                            |



    Returns the flat delivery rate (LKR), whether the requested date is available,
    and — if not — the next available date plus reason. Kapruka delivers as a
    single shipment per order at one flat rate regardless of item count.

    If a `product_id` is supplied and the code matches a perishable family
    (CAKE*, FLOWER*, COMBO*), an extra warning is added when the chosen
    delivery date is more than 1 day out.

    Args:
        params (CheckDeliveryInput):
            - city (str): Canonical city name (e.g. 'Colombo 03', 'Galle')
            - delivery_date (Optional[str]): YYYY-MM-DD; defaults to today (LK time)
            - product_id (Optional[str]): Optional, enables perishable warning
            - response_format (str): 'markdown' (default) or 'json'

    Returns:
        str: Delivery feasibility + rate in the requested format.

        JSON schema:
        {
          "city": str,
          "now": str,                       # ISO timestamp, Sri Lanka time
          "checked_date": str,              # YYYY-MM-DD
          "available": bool,
          "rate": number,                   # flat LKR rate per order
          "currency": "LKR",
          "reason": str | null,             # populated when available=false
          "next_available_date": str|null,  # populated when available=false
          "perishable_warning": str | null  # populated when product_id is perishable
        }
    
### Name: kapruka_create_order

Description: Create a guest-checkout order on Kapruka and return a click-to-pay link.

- Checkout link expires in **60 minutes**
- Always verify city with `list_delivery_cities` and date with `check_delivery` **before** creating
- Use `"json"` to extract the `checkout_url` and `grand_total`
- The returned `order_ref` is a **pre-payment** reference — **not** the final order number
- Rate limit: 30 orders/hour per IP

| Parameter         | Type                     | Required | Default      | Description                                     |
| ----------------- | ------------------------ | -------- | ------------ | ----------------------------------------------- |
| **`cart`**        | array of CartItem        | **Yes**  | —            | 1–30 items                                      |
| ↳ `product_id`    | string                   | **Yes**  | —            | Product ID                                      |
| ↳ `quantity`      | int (1-99)               | No       | `1`          | Quantity                                        |
| ↳ `icing_text`    | string \| null (max 120) | No       | `null`       | Cake icing text (ignored for non-cakes)         |
| **`recipient`**   | object                   | **Yes**  | —            | Delivery recipient                              |
| ↳ `name`          | string (1-80)            | **Yes**  | —            | Recipient name                                  |
| ↳ `phone`         | string (7-30)            | **Yes**  | —            | Phone in E.164 (`+9477...`) or local (`077...`) |
| **`delivery`**    | object                   | **Yes**  | —            | Delivery details                                |
| ↳ `address`       | string (3-250)           | **Yes**  | —            | Street address                                  |
| ↳ `city`          | string (2-100)           | **Yes**  | —            | Must be a valid Kapruka delivery city           |
| ↳ `date`          | string                   | **Yes**  | —            | `YYYY-MM-DD`, today or future (Asia/Colombo)    |
| ↳ `location_type` | string                   | No       | `"house"`    | `house`, `apartment`, `office`, `other`         |
| ↳ `instructions`  | string \| null (max 250) | No       | `null`       | Delivery instructions                           |
| **`sender`**      | object                   | **Yes**  | —            | Sender info for gift card                       |
| ↳ `name`          | string (1-80)            | **Yes**  | —            | Sender name                                     |
| ↳ `anonymous`     | bool                     | No       | `false`      | Hide sender name on gift card                   |
| `gift_message`    | string \| null (max 300) | No       | `null`       | Gift card message                               |
| `currency`        | string                   | No       | `"LKR"`      | Pricing currency                                |
| `response_format` | string                   | No       | `"markdown"` | `"markdown"` or `"json"`                        |



    Builds a Kapruka order from the supplied cart + recipient + delivery + sender,
    then returns a checkout URL the customer opens in a browser to complete payment.
    No Kapruka account is required. Prices are locked for the lifetime of the link
    (60 minutes) — the customer pays exactly the quoted grand total even if the
    catalog price changes meanwhile.

    Free public tier limits: 30 orders per hour per client IP. Cart up to 30 items,
    quantity up to 99 per item. A fresh idempotency key is generated per call so
    retries on transient errors return the same checkout URL rather than duplicates.

    Args:
        params (CreateOrderInput):
            - cart (list[CartItem]): 1–30 items. Each: product_id, quantity (default 1), optional icing_text (cakes only).
            - recipient (Recipient): name + phone (E.164 +9477… or local 077…)
            - delivery (Delivery): address, city (must be Kapruka-deliverable — use kapruka_list_delivery_cities), location_type (house/apartment/office/other, default house), date (YYYY-MM-DD, today-or-future Asia/Colombo), optional instructions
            - sender (Sender): name + anonymous flag
            - gift_message (Optional[str]): Up to 300 chars
            - currency (str): LKR (default), USD, GBP, AUD, CAD, EUR
            - response_format (str): 'markdown' (default) or 'json'

    Returns:
        str: Order confirmation with checkout URL.

        JSON schema:
        {
          "checkout_url": str,           # Open in browser to pay (no login required)
          "order_ref": str,              # e.g. "ORD-20260520-7823"
          "summary": {
            "items_total":   number,
            "delivery_fee":  number,
            "addons_total":  number,
            "grand_total":   number,     # items_total + delivery_fee + addons_total
            "currency":      str
          },
          "expires_at": str              # ISO 8601 — link stops working after this
        }

        Error: "Error (<code>): <message>" on failure. Common codes:
          empty_cart, missing_field, past_delivery_date, product_not_found,
          product_out_of_stock, city_not_deliverable, date_not_deliverable.
    

### Name: kapruka_track_order

Description: Look up status and delivery progress for a Kapruka order by order number.

**💡 Tips:**

- This is **NOT** the `order_ref` from `create_order` — the customer must complete payment first, then Kapruka emails them the real order number
- Use `"json"` to check `status`, `progress` timeline, and `has_delivery_photo`/`has_delivery_video` flags

| Parameter         | Type                | Required | Default      | Description                                                  |
| ----------------- | ------------------- | -------- | ------------ | ------------------------------------------------------------ |
| `order_number`    | string (4-40 chars) | **Yes**  | —            | Order number from confirmation email (e.g. `"VIMP34456CB2"`) |
| `response_format` | string              | No       | `"markdown"` | `"markdown"` or `"json"`                                     |



    Returns current status (received / confirmed / out-for-delivery / delivered /
    cancelled), the recipient and delivery details on file, a timestamped progress
    timeline, the cart contents, and flags for whether a delivery photo or video is
    available. Use this after a customer has placed and paid for an order and reads
    back the order number from their confirmation email or the order complete page.

    The order number is NOT the `order_ref` returned by kapruka_create_order
    (which is the pre-payment checkout reference). Once the customer completes
    payment in the browser, Kapruka emails them a separate order number — that
    is what this tool expects.

    Args:
        params (TrackOrderInput):
            - order_number (str): Kapruka order number (e.g. 'VIMP34456CB2')
            - response_format (str): 'markdown' (default) or 'json'

    Returns:
        str: Order tracking details in the requested format.

        JSON schema:
        {
          "order_number": str,
          "pnref": str,                 # internal payment reference (numeric; not the same as order_number)
          "status": str,                # received | confirmed | shipped | delivered | cancelled | ...
          "status_display": str,        # human label
          "order_date": str,            # human-formatted, Asia/Colombo
          "delivery_date": str,         # human-formatted
          "shipped_date": str | null,
          "amount": str,                # LKR string (e.g. "15500.00")
          "payment_method": str,
          "comments": str | null,
          "recipient": {"name": str, "phone": str, "address": str, "city": str},
          "greeting_message": str | null,
          "special_instructions": str | null,
          "progress": [{"step": str, "timestamp": str}],
          "live_tracking_available": bool,
          "has_delivery_video": bool,
          "has_delivery_photo": bool,
          "items": [{"product_id": str, "name": str, "quantity": int, "selling_price": float}]
        }

        Error: "Error: <message>" on failure (e.g. order not found).

