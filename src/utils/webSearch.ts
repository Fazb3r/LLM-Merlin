export function looksLikeWebQuestion(prompt: string): boolean {
    const q = prompt.toLowerCase().trim();

    // Very short or clearly casual → no web
    if (q.length < 8) return false;

    // Time-based triggers
    const timeKeywords = [
        // Spanish
        "hoy", "ayer", "mañana",
        "esta semana", "este mes", "este año",
        "últimas noticias", "último", "reciente",
        "actualmente", "ahora mismo",
        "2023", "2024", "2025", "2026",
        "anoche", "últimamente",

        // English
        "today", "yesterday", "tomorrow",
        "this week", "this month", "this year",
        "latest", "recent", "recently",
        "currently", "right now",
        "news", "breaking",
    ];

    // Fact-based triggers (info that usually changes over time)
    const factKeywords = [
        // Spanish
        "precio", "precios", "cotización", "valor",
        "acciones", "dólar", "euro", "inflación",
        "clima", "tiempo", "temperatura", "pronóstico",
        "ganador", "ganadores", "perdedor",
        "resultado", "resultados", "marcador", "score",
        "nominado", "nominados", "nominadas",
        "ranking", "top", "tendencias", "tendencia",
        "estreno", "lanzamiento",
        "review", "reseñas", "opiniones",
        "worlds", "mundial", "torneo", "liga",
        "lol", "league of legends", "valorant", "csgo", "dota",
        "fútbol", "nba", "mlb",

        // English
        "price", "prices", "stock", "stocks", "rate",
        "weather", "forecast", "temperature",
        "winner", "winners", "loser",
        "result", "results", "scoreboard",
        "nominated", "nominees", "nomination",
        "launch", "release", "released",
        "review", "reviews", "opinions",
        "trending", "trend",
        "ranking", "standings",
        "championship", "tournament", "league", "cup",
        "goty", "game of the year",
        "esports", "matches", "fixtures",
    ];

    // Verbs meaning "go search / investigate"
    const intentKeywords = [
        // Spanish
        "investiga", "investigar", "investigame",
        "averigua", "averiguar",
        "busca", "búscame", "buscame",
        "consulta", "confirma", "verifica",
        
        // English
        "search", "lookup", "look up", "check", "find",
        "investigate", "investigate for me",
        "look for", "look this up", "research",
    ];

    const hasTime = timeKeywords.some((k) => q.includes(k));
    const hasFact = factKeywords.some((k) => q.includes(k));
    const hasIntent = intentKeywords.some((k) => q.includes(k));

    // Any of these three is enough
    return hasTime || hasFact || hasIntent;
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
