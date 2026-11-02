// Vite's `?raw` imports (used by tests to read non-source files verbatim).
declare module "*?raw" {
	const content: string;
	export default content;
}
