# chat

This example demonstrates a simple chat application built with gatho assembles as a "onebox" deployment.

The "onebox" approach uses `createMemoryDriver()` and runs the server and rooms on the same host. This is great for getting started quickly without redis, and is suitable for local development, dev environments, and deployments that don't require horizontal scaling.
