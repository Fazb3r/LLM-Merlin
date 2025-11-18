// src/utils/webSearch.ts

/**
 * Detecta si el usuario está explícitamente pidiendo una búsqueda web.
 * Solo activa la búsqueda cuando hay comandos claros de búsqueda.
 */
export function shouldSearchWeb(prompt: string): boolean {
    const q = prompt.toLowerCase().trim();

    // Comandos explícitos de búsqueda en español
    const spanishSearchCommands = [
        "busca",
        "búscame",
        "buscame",
        "investiga",
        "investigame",
        "investígame",
        "averigua",
        "averiguame",
        "averíguame",
        "consulta",
        "consultame",
        "consúltame",
    ];

    // Comandos explícitos de búsqueda en inglés
    const englishSearchCommands = [
        "search",
        "search for",
        "look up",
        "lookup",
        "look this up",
        "find out",
        "check",
        "investigate",
    ];

    // Verificar si el mensaje EMPIEZA con alguno de estos comandos
    // o si contiene el comando seguido de espacio/puntuación
    for (const cmd of [...spanishSearchCommands, ...englishSearchCommands]) {
        if (q.startsWith(cmd + " ") || 
            q.startsWith(cmd + ",") || 
            q === cmd ||
            q.includes(" " + cmd + " ") ||
            q.includes(" " + cmd + ",")) {
            return true;
        }
    }

    return false;
}

/**
 * Función legacy - ahora simplemente llama a shouldSearchWeb
 * @deprecated Use shouldSearchWeb instead
 */
export function looksLikeWebQuestion(prompt: string): boolean {
    return shouldSearchWeb(prompt);
}

/**
 * Función legacy - removida la complejidad de keywords
 * @deprecated No longer needed with simplified approach
 */
export function hasExplicitSearchKeyword(prompt: string): boolean {
    return shouldSearchWeb(prompt);
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