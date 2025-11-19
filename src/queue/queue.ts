import {
    ChatInputCommandInteraction,
    TextChannel,
    ThreadAutoArchiveDuration,
    ThreadChannel,
} from "discord.js";

import Groq from "groq-sdk";
import { MERLIN_SYSTEM_PROMPT } from "../system/system";
import { setTimeout as wait } from "node:timers/promises";
import { shouldSearchWeb, searchWebWithTavily } from "../utils/webSearch";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

interface QueueObject {
    [interactionId: string]: {
        interaction: ChatInputCommandInteraction;
        status: {
            position: number;
            processing: boolean;
            waiting: boolean;
        };
        thread: ThreadChannel | undefined;
    };
}

class Queue {
    queue: QueueObject;
    interval: NodeJS.Timeout | undefined;

    // How many tasks to process at the same time
    private static readonly CONCURRENT_QUEUE_SIZE = 3;

    // Default model if GROQ_MODEL not set
    private static readonly LLM_MODEL =
        process.env.GROQ_MODEL || "gpt-oss-20b";

    constructor() {
        this.queue = {};
    }

    addItem(interaction: ChatInputCommandInteraction) {
        const queueLength = this.length();

        this.queue[interaction.id] = {
            interaction,
            status: {
                position: queueLength, // 0-based index
                processing: false,
                waiting: false,
            },
            thread: undefined,
        };

        if (!this.interval) {
            console.log("Starting the queue processor");
            this.startQueue();
        }
    }

    removeItem(interactionId: string) {
        console.log(`Removed ${interactionId} from queue`);
        delete this.queue[interactionId];

        // Re-normalize positions
        const ids = Object.keys(this.queue).sort(
            (a, b) =>
                this.queue[a].status.position - this.queue[b].status.position,
        );

        ids.forEach((id, index) => {
            this.queue[id].status.position = index;
        });
    }

    getItem(interactionId: string) {
        return this.queue[interactionId];
    }

    length() {
        return Object.keys(this.queue).length;
    }

    isEmpty() {
        return this.length() === 0;
    }

    startQueue() {
        if (this.interval) return;
        // Check more often for lower latency
        this.interval = setInterval(() => {
            void this.processQueue();
        }, 500);
    }

    stopQueue() {
        console.log(
            "Entire queue has been processed. Stopping the queue processor",
        );
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    assignThread(interactionId: string, thread: ThreadChannel) {
        if (!this.queue[interactionId]) return;
        this.queue[interactionId].thread = thread;
    }

    private async processQueue(): Promise<void> {
        if (this.isEmpty()) {
            this.stopQueue();
            return;
        }

        // Process items in queue order
        const ids = Object.keys(this.queue).sort(
            (a, b) =>
                this.queue[a].status.position - this.queue[b].status.position,
        );

        // Count already processing
        let currentlyBeingProcessedCount = ids.filter(
            (id) => this.queue[id].status.processing,
        ).length;

        for (const interactionId of ids) {
            const item = this.queue[interactionId];
            const { position, processing, waiting } = item.status;
            const interaction = item.interaction;
            const channelId = interaction.channelId;
            const channel = await interaction.client.channels.fetch(channelId);

            if (!channel || !("isTextBased" in channel) || !channel.isTextBased()) {
                continue;
            }

            // Not processing yet
            if (!processing) {
                if (
                    currentlyBeingProcessedCount <
                    Queue.CONCURRENT_QUEUE_SIZE
                ) {
                    console.log(
                        `Processing task with interaction id ${interactionId}`,
                    );
                    item.status.processing = true;
                    item.status.waiting = false;

                    // Fire and forget; errors handled inside processTask
                    void this.processTask(
                        interaction,
                        channel as TextChannel,
                    );

                    currentlyBeingProcessedCount++;
                } else {
                    // In queue: update message once, don't spam
                    if (!waiting) {
                        item.status.waiting = true;
                        const peopleAhead = Math.max(
                            0,
                            position - Queue.CONCURRENT_QUEUE_SIZE,
                        );

                        await wait(500);
                        await interaction.editReply(
                            peopleAhead > 0
                                ? `There are ${peopleAhead} people ahead of you in the queue. Please wait your turn...`
                                : `You are currently waiting in the queue. Please wait your turn...`,
                        );
                    }
                }
            }
        }
    }

    private async processTask(
        interaction: ChatInputCommandInteraction,
        channel: TextChannel,
    ): Promise<void> {
        console.time("merlin-total");

        const prompt = interaction.options.getString("input") ?? "hi";
        const userId = interaction.user.id;
        const userName = interaction.user.displayName;

        console.log(
            `User sent message ${userId} with prompt: ${prompt}`,
        );

        const newThread = await channel.threads.create({
            name: `[${userName}] - Prompt: ${prompt.slice(0, 40) || "Prompt"}`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
            reason: "LLM Bot Auto Created Thread",
        });

        this.assignThread(interaction.id, newThread);

        try {
            console.time("groq-call");

            // 1) Solo buscar si hay comando explícito de búsqueda
            let webContext = "";
            if (prompt && shouldSearchWeb(prompt)) {
                console.log("Explicit search command detected, calling Tavily...");
                const web = await searchWebWithTavily(prompt, "general");
                if (web) {
                    webContext = web;
                }
            }

            // 2) Build messages for Groq (Merlin + optional web info)
            const messages: { role: "system" | "user"; content: string }[] = [
                { role: "system", content: MERLIN_SYSTEM_PROMPT },
            ];

            if (webContext) {
                messages.push({
                    role: "system",
                    content:
                        "Información reciente obtenida de la web. Úsala para responder con precisión, " +
                        "pero mantén tu tono y personalidad de Merlin. Si algo no está claro, dilo honestamente:\n\n" +
                        webContext,
                });
            }

            messages.push({
                role: "user",
                content: prompt,
            });

            // 3) Call Groq with Merlin + (maybe) web context
            const completion = await groq.chat.completions.create({
                model: Queue.LLM_MODEL,
                messages,
                max_tokens: 256,
                temperature: 0.7,
            });

            console.timeEnd("groq-call");

            const fullResponse =
                completion.choices[0]?.message?.content ??
                "Merlin couldn't think of anything to say 🧙‍♀️";

            await newThread.send(fullResponse);

            try {
                await interaction.deleteReply();
            } catch {
                // ignore
            }

            this.removeItem(interaction.id);
        } catch (error: unknown) {
            console.error("Error while calling Groq:", error);
            await newThread.send(
                "Merlin ran into an error talking to the model. Try again in a bit 🧙‍♀️",
            );
            await interaction.editReply(
                "An error occured. Please try again later.",
            );
            this.removeItem(interaction.id);
        }

        console.timeEnd("merlin-total");
    }
}

export default Queue;