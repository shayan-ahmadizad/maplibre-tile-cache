import { defineConfig } from 'vite';

export default defineConfig({
  // The example imports the library straight from ../../src.
  // Bind to the loopback address. `localhost` is left unset in /etc/hosts here
  // and the resolver answers with a fake-ip (198.18.0.0/15) that nothing listens on.
  server: { host: '127.0.0.1', fs: { allow: ['../..'] } },
});
