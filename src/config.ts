export interface Config {
  port: number;
}

export function loadConfig(): Config {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  if (isNaN(port) || port <= 0) {
    console.error("Invalid PORT value");
    process.exit(1);
  }

  return { port };
}
