declare module '*?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, unknown>;
}
