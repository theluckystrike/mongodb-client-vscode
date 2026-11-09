# Add a MongoDB connection

1. Click Add Connection in the MongoDB Explorer.
2. Paste a connection string: `mongodb://localhost:27017`, `mongodb://user@host1,host2/?replicaSet=rs0` or `mongodb+srv://cluster0.example.mongodb.net`.
3. Type the password in the Password field. It is kept in VS Code secret storage, never in settings. A password inside the string is moved there when you save.
4. Click Test connection, then Save.

The extension connects only when you open the connection, and closes it after 10 idle minutes (setting `zovoMongo.idleCloseMinutes`). No telemetry, no keep-alive.
