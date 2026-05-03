# AI Accessibility Backend

## Quick Start

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 5000
```

The server starts at **http://localhost:5000**

## Endpoints

| Method | Path        | Purpose                           |
|--------|-------------|-----------------------------------|
| GET    | /health     | Check server is alive             |
| POST   | /caption    | Generate alt-text for an image    |
| POST   | /simplify   | Simplify complex text             |

## Example — Caption

```bash
curl -X POST http://localhost:5000/caption \
  -H "Content-Type: application/json" \
  -d '{"image_url": "https://example.com/photo.jpg"}'
```

Response:
```json
{"caption": "a dog running on a green grass field", "image_url": "..."}
```

## Example — Simplify

```bash
curl -X POST http://localhost:5000/simplify \
  -H "Content-Type: application/json" \
  -d '{"text": "The mitochondria are membrane-bound organelles found in the cytoplasm..."}'
```

Response:
```json
{"simplified": "Mitochondria are tiny parts inside cells that make energy.", ...}
```

## Notes

- Models are lazy-loaded on first request (~10–30 seconds); subsequent calls are fast.
- For production use, consider running behind gunicorn with multiple workers.
