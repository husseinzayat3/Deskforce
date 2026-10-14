# Docker

Each release publishes an image for Intel and ARM machines, so no checkout is needed:

```bash
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/workspace:/app/workspace --env-file .env.local ghcr.io/husseinzayat3/deskforce
```

Or build it from the source:

```bash
docker build -t deskforce .
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/workspace:/app/workspace --env-file .env.local deskforce
```

Mount `/app/workspace` as shown to keep the generated files and the database. To use Ollama from the container, point `OLLAMA_URL` at the host, for example `-e OLLAMA_URL=http://host.docker.internal:11434`.

The office has no login: publish the port to this computer only (`127.0.0.1:3000:3000`, as above). See the [security model](security.md).
