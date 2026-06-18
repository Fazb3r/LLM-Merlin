// src/utils/webSearch.ts

/**
 * Detecta si el usuario está explícitamente pidiendo una búsqueda web.
 */
export function shouldSearchWeb(prompt: string): boolean {
    const q = prompt.toLowerCase().trim();

    // Comandos explícitos de búsqueda en español
    const spanishSearchCommands = [
        "busca",
        "buscar",
        "búscame",
        "buscame",
        "investiga",
        "investigar",
        "investigame",
        "investígame",
        "averigua",
        "averiguar",
        "averiguame",
        "averíguame",
        "consulta",
        "consultar",
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
 * Detecta si la pregunta parece ser sobre eventos actuales o información reciente
 * que está más allá del conocimiento de Merlin (después de diciembre 2023)
 */
export function looksLikeCurrentEventQuestion(prompt: string): boolean {
    const q = prompt.toLowerCase();
    
    // Indicadores temporales que sugieren información reciente
    const temporalIndicators = [
        // Años recientes
        "2024", "2025", "2026", "2027", "2028",
        
        // Tablas y competiciones dinámicas (información en tiempo real)
        "tabla", "posiciones", "standings", "standing", "calendario", "fixture",
        "partidos de", "partido de", "clasificación", "clasificados", "resultados",
        "tabla de posiciones", "lck", "lpl", "lec", "lcs", "msi", "worlds",
        
        // Indicadores de tiempo presente/reciente - Español
        "hoy", "ahora", "actual", "actualmente", "este año", "este mes",
        "últimamente", "recientemente", "reciente", "último", "última",
        "esta semana", "este fin de semana", "últimos días",
        
        // Indicadores de tiempo presente/reciente - Inglés
        "today", "now", "current", "currently", "this year", "this month",
        "lately", "recently", "recent", "latest", "last week", "this week",
        
        // Eventos que típicamente son actuales
        "precio", "cotización", "vale", "cuesta", "cuánto cuesta",
        "price", "cost", "worth", "how much",
        
        // Noticias y eventos
        "noticia", "noticias", "pasó", "ocurrió", "sucedió",
        "news", "happened", "occurred",
        
        // Premios y eventos anuales
        "grammy", "grammys", "oscar", "oscars", "mundial", "world cup",
        "elecciones", "election", "olimpiadas", "olympics",
    ];
    
    // Frases que casi siempre indican búsqueda de info actual
    const currentEventPhrases = [
        "qué pasó",
        "que paso",
        "what happened",
        "ganó los",
        "ganaron los",
        "won the",
        "quién ganó",
        "quien gano",
        "who won",
        "cuánto vale",
        "cuanto vale",
        "how much is",
    ];
    
    // Verificar frases específicas primero (más específicas)
    for (const phrase of currentEventPhrases) {
        if (q.includes(phrase)) {
            return true;
        }
    }
    
    // Verificar indicadores temporales
    for (const indicator of temporalIndicators) {
        if (q.includes(indicator)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Genera un mensaje de sugerencia cuando se detecta una pregunta sobre eventos actuales
 */
export function getSuggestedSearchMessage(prompt: string): string {
    const q = prompt.toLowerCase();
    
    // Detectar el idioma predominante
    const spanishWords = ["qué", "que", "cómo", "como", "cuánto", "cuando", "dónde", "donde"];
    const isSpanish = spanishWords.some(word => q.includes(word));
    
    if (isSpanish) {
        return "Mi conocimiento llega hasta diciembre de 2023. Para obtener información actualizada, " +
               "usa comandos como: 'busca...', 'consultame...', 'investiga...', o 'averigua...' " +
               "seguido de tu pregunta.";
    } else {
        return "My knowledge ends in December 2023. For current information, " +
               "use commands like: 'search...', 'look up...', or 'find out...' " +
               "followed by your question.";
    }
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