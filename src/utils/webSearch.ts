    // src/utils/webSearch.ts
    export function looksLikeWebQuestion(prompt: string): boolean {
    const q = prompt.toLowerCase().trim();

    // Very short or clearly casual -> no web
    if (q.length < 20) return false;

    // Time-related words: usually imply "current info"
    const timeKeywords = [
        "hoy", "ayer", "mañana", "esta semana", "este mes", "este año",
        "últimas noticias", "último", "reciente", "actualmente", "ahora mismo",
        "2023", "2024", "2025"
    ];

    // Fact / real-world info
    const factKeywords = [
        "precio", "cotización", "acciones", "dólar", "euro", "clima", "tiempo",
        "temperatura", "pronóstico", "ganador", "nominados", "resultados",
        "marcador", "noticias", "tendencias", "estreno", "lanzamiento",
        "ranking", "top", "mejores juegos", "review", "reseñas"
    ];

    const anyTime = timeKeywords.some(k => q.includes(k));
    const anyFact = factKeywords.some(k => q.includes(k));

    return anyTime || anyFact;
    }

    // Uses global fetch (Node 18+). Make sure TAVILY_API_KEY is set in env.
    export async function searchWebWithTavily(
    query: string,
    topic: "news" | "general" = "general"
    ): Promise<string | null> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        console.warn("TAVILY_API_KEY is not set, skipping web search.");
        return null;
    }

    const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
        query,
        topic,
        search_depth: "advanced",
        include_answer: true,
        max_results: 5,
        }),
    });

    if (!res.ok) {
        console.error("Tavily HTTP error", res.status, await res.text());
        return null;
    }

    const data: any = await res.json();

    // Build a compact text summary to feed into Groq
    const parts: string[] = [];

    if (data.answer) {
        parts.push(`Respuesta resumida de la web:\n${data.answer}`);
    }

    if (Array.isArray(data.results)) {
        const top = data.results.slice(0, 3);
        parts.push(
        "Fuentes consultadas:\n" +
            top
            .map(
                (r: any, i: number) =>
                `${i + 1}. ${r.title} — ${r.url}\n${r.content}`
            )
            .join("\n\n")
        );
    }

    return parts.join("\n\n");
    }
