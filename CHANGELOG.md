# Changelog

## 0.1.0

- First release: MongoDB client and MongoDB GUI for VS Code.
- Connections by connection string (mongodb:// and mongodb+srv://), user and password in secret storage, TLS with a CA file, replica sets, direct connection, read preference, a read-only switch per connection.
- Explorer with databases, collections, views and indexes, loaded on expand, with estimated document counts.
- Documents grid with nested documents and arrays opening into columns, JSON view side by side, inline edits that keep BSON types, insert, delete, edit as JSON.
- Query bar with filter, projection, sort, limit and skip, field autocomplete from a 100-document sample, "Load more" from the open cursor, explain with plain hints, bulk update and delete with confirmations.
- Aggregation pipeline editor with a per-stage preview, run, explain, export and server-side cancel.
- Indexes: create (single, compound, unique, sparse, TTL) and drop.
- Streamed export to JSON, JSONL and CSV; import from JSON, JSONL and CSV in batches with a progress bar.
- Zovo Pro (optional, 3 free tries each): Schema Analysis with a $jsonSchema draft, Compare Two Collections with a mongosh sync script.
- No telemetry, no connection on startup, no keep-alive; idle connections close after 10 minutes.
- Support links (Rate, More free viewers, Sponsor, PayPal) under the grid, "Support Zovo" and "More tools by Zovo" in this README, and a format request form for paid custom work.
