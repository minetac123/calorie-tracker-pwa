# Project Plan: Calorie Tracker PWA Food Search API Proxy Fix

## Architecture
- Frontend: HTML5/JS PWA that calls `/api/search?q=<query>` to query the online database of products.
- Backend: Vercel serverless function in `api/search.js` which proxies the request to OpenFoodFacts or another online API.
- Data Flow:
  - User types search query in UI -> `app.js` calls `/api/search?q=<query>` -> `api/search.js` fetches from OpenFoodFacts -> mapping/filtering -> response returned to `app.js` -> UI updates with product details.
  - Expected API response format: JSON containing a `products` array.
  - `app.js` expects each product in `products` to support OpenFoodFacts schema (specifically properties like `product_name_cs`, `product_name`, `brands`, `nutriments.energy-kcal_100g`, `nutriments.proteins_100g`, etc.).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration | Analyze current search API, OpenFoodFacts endpoint stability, and check connection. | None | PLANNED |
| 2 | Implementation | Repair search logic in `api/search.js` and implement `test_search.js`. | M1 | PLANNED |
| 3 | Verification | Validate with Reviewer, Challenger, and Forensic Auditor. | M2 | PLANNED |

## Interface Contracts
- API Request: `GET /api/search?q=<query>`
- API Response (200 OK):
  ```json
  {
    "products": [
      {
        "product_name_cs": "Jablko",
        "product_name": "Apple",
        "brands": "Sklizeno",
        "nutriments": {
          "energy-kcal_100g": 52,
          "proteins_100g": 0.3,
          "carbohydrates_100g": 14,
          "fat_100g": 0.2
        }
      }
    ]
  }
  ```
- API Response on empty / not found query (200 OK):
  ```json
  {
    "products": []
  }
  ```
- API Response on missing query (400 Bad Request):
  ```json
  {
    "error": "Chybí vyhledávací dotaz"
  }
  ```
