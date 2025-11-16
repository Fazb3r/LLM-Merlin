    import {
    ChatInputCommandInteraction,
    DiscordAPIError,
    TextChannel,
    ThreadAutoArchiveDuration,
    ThreadChannel,
    Channel,
    } from "discord.js";

    const wait = require("node:timers/promises").setTimeout;

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

    private static readonly CONCURRENT_QUEUE_SIZE = 3;
    private static readonly LLM_MODEL = "gpt-oss:20b";

    constructor() {
        this.queue = {};
    }

    addItem(interaction: ChatInputCommandInteraction) {
        const queueLength = this.length();

        this.queue[interaction.id] = {
        interaction,
        status: {
            position: queueLength,
            processing: false,
            waiting: false,
        },
        thread: undefined,
        };

        if (this.interval === undefined) {
        console.log("Starting the queue processor");
        this.startQueue();
        }
    }

    removeItem(interactionId: string) {
        console.log(`Removed ${interactionId} from queue`);
        delete this.queue[interactionId];

        // recompute positions
        const ids = Object.keys(this.queue);
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
        this.interval = setInterval(() => this.processQueue(), 3000);
    }

    stopQueue() {
        console.log("Entire queue has been processed. Stopping the queue processor");
        clearInterval(this.interval);
        this.interval = undefined;
    }

    assignThread(interactionId: string, thread: ThreadChannel) {
        this.queue[interactionId].thread = thread;
    }

    processQueue = async () => {
        if (this.isEmpty()) {
        this.stopQueue();
        return;
        }

        const interactionIds = Object.keys(this.queue);
        let currentlyBeingProcessedCount = 0;

        for (const interactionId of interactionIds) {
        const item = this.queue[interactionId];
        const positionInQueue = item.status.position;
        const processing = item.status.processing;
        const interaction = item.interaction;

        const channel = (await interaction.client.channels.fetch(
            interaction.channelId,
        )) as Channel | null;

        if (!channel) {
            console.warn(
            `Channel not found for interaction ${interactionId}, removing from queue.`,
            );
            this.removeItem(interactionId);
            continue;
        }

        if (!processing && currentlyBeingProcessedCount < Queue.CONCURRENT_QUEUE_SIZE) {
            console.log(`Processing task with interaction id ${interactionId}`);
            item.status.processing = true;
            this.processTask(interaction, channel);
            currentlyBeingProcessedCount++;
        } else if (!processing && currentlyBeingProcessedCount >= Queue.CONCURRENT_QUEUE_SIZE) {
            await wait(3000);
            await interaction.editReply(
            `There are ${
                positionInQueue - Queue.CONCURRENT_QUEUE_SIZE
            } people ahead of you in the queue. Please wait your turn...`,
            );
        } else {
            currentlyBeingProcessedCount++;
        }
        }
    };

    processTask = async (
        interaction: ChatInputCommandInteraction,
        channel: Channel,
    ) => {
        const prompt = interaction.options.getString("input") ?? "";
        const userId = interaction.user.id;
        const userName = interaction.user.displayName;

        console.log(`User sent message ${userId} with prompt: ${prompt}`);

        let newThread: ThreadChannel | null = null;

        try {
        // 1) Decide where to answer
        if (channel instanceof ThreadChannel) {
            // If the command was used inside a thread, reuse that thread
            console.log("Command used inside a thread, reusing existing thread.");
            newThread = channel;
        } else if (channel instanceof TextChannel) {
            // If it's a normal text channel, create a new thread
            newThread = await channel.threads.create({
            name: `[${userName}] - Prompt: ${prompt || "Prompt"}`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
            reason: "LLM Bot Auto Created Thread",
            });
        } else {
            console.warn(
            "Unsupported channel type for threads, replying in place instead.",
            );
            // Fallback: no thread support → reply in the original channel
            // @ts-ignore
            newThread = (channel as any) as ThreadChannel;
        }

        if (!newThread) {
            await interaction.editReply(
            "Merlin could not find a place to answer. Try again in a normal text channel.",
            );
            this.removeItem(interaction.id);
            return;
        }

        this.assignThread(interaction.id, newThread);

        // 2) Call Ollama (non-streaming)
        const url = "http://localhost:11434/api/generate";

        const body = {
            model: Queue.LLM_MODEL,
            prompt: prompt,
            stream: false,
        };

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            console.error("Ollama returned non-OK:", res.status, res.statusText);
            await interaction.editReply(
            "Merlin had trouble thinking. Try again in a moment.",
            );
            this.removeItem(interaction.id);
            return;
        }

        const json = (await res.json()) as { response?: string };
        const answer = (json.response ?? "").trim();

        if (!answer) {
            console.warn("Ollama responded with empty text.");
            await newThread.send("Merlin is silent… something went wrong.");
        } else {
            await newThread.send(answer);
        }

        // 3) Clean up queue + ephemeral message
        await wait(500);
        await interaction.deleteReply();
        this.removeItem(interaction.id);

        console.log(`Task with interaction id ${interaction.id} complete.`);
        } catch (error) {
        console.error("Error in processTask:", error);

        if (error instanceof DiscordAPIError && error.code === 10008) {
            if (newThread) {
            await newThread.send(
                "⚠️ Sending messages in this thread while Merlin is answering might break the response.",
            );
            }
        }

        try {
            if (interaction.isRepliable()) {
            await interaction.editReply(
                "Merlin encountered an error while processing your prompt.",
            );
            }
        } catch {
            // ignore follow-up errors
        }

        this.removeItem(interaction.id);
        }
    };
    }

    export default Queue;
