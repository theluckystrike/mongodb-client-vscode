# Query and edit documents

- Click a collection. The grid shows the first 50 documents; Load more reads the next page from the open cursor.
- Type a filter such as `{ status: "active", "address.city": "Berlin" }` and press Enter. Field names complete as you type.
- Options adds projection, sort, limit and skip. Click a column header to sort on the server.
- Click ▸ in a cell to open a nested document or array into columns.
- Double-click a cell to edit it. The type is kept: an Int64 stays an Int64, a Decimal128 keeps its exact digits.
- The JSON view on the right shows the selected document; Edit JSON saves the whole document.
