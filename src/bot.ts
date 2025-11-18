require("dotenv").config();
import path from "path";
import fs from "fs";
import { Client, Collection, Events, GatewayIntentBits } from "discord.js";
import deployCommands from "./deploy/deployCommands";
import { MERLIN_SYSTEM_PROMPT } from "./system/system";
import Groq from "groq-sdk";
import { looksLikeWebQuestion, searchWebWithTavily } from "./utils/webSearch";




// Load environment variables
const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN; 
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Create an instance of Client and set the intents to listen for messages.
const client = new Client({
    intents: [
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
    ],
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);


for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		// Set a new item in the Collection with the key as the command name and the value as the exported module
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

//Register our commands
//deployCommands();

// Once the WebSocket is connected, log a message to the console.
client.once(Events.ClientReady, () => {
    console.log('Bot is online!');
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
		} else {
			await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
		}
	}
});



client.on(Events.MessageCreate, async (message) => {
  // 1) Ignore bot messages (including Merlin herself)
  if (message.author.bot) return;

  const isDM = !message.guild;
  const botUser = client.user;
  if (!botUser) return;

  const contentLower = message.content.toLowerCase();

  // 2) Decide if Merlin should answer
  let shouldAnswer = false;

  if (isDM) {
    // In DMs, answer everything
    shouldAnswer = true;
  } else {
    // In servers, answer if:
    // - user @mentions the bot
    // - or message calls her by name / alias
    const mentionedMe = message.mentions.has(botUser);

    const saidMerlin = contentLower.includes("merlin");
    const saidMer =
    	contentLower.startsWith("mer ") ||
    	contentLower.startsWith("mer,") ||
    	contentLower.startsWith("mer:") ||
    	contentLower === "mer";
    const saidMerlina =
    	contentLower.includes("merlina") ||
    	contentLower.startsWith("merlina");

    if (mentionedMe || saidMerlin || saidMer || saidMerlina) {
    	shouldAnswer = true;
    }
}

if (!shouldAnswer) return;

  // 3) Clean the user text (remove the mention tag if present)
	const rawText = message.content.replace(/<@!?\d+>/g, "").trim();
	if (!rawText) {
    // If they just wrote "@Merlin" or "Mer" and nothing else
    return message.reply("¿Sí, Faiber? 🧙‍♀️");
	}

	try {
    console.time("merlin-mention-groq");

    // 4) Decide if this looks like a web question
    let webContext = "";
    if (looksLikeWebQuestion(rawText)) {
    	console.log("Mention looks like web question, calling Tavily...");
    	const web = await searchWebWithTavily(rawText, "news");
    	if (web) {
        webContext = web;
    	}
    }

    // 5) Build messages for Groq (Merlin + optional web info)
    const messages: { role: "system" | "user"; content: string }[] = [
    	{ role: "system", content: MERLIN_SYSTEM_PROMPT },
    ];

    if (webContext) {
    	messages.push({
        role: "system",
        content:
        	"Información reciente obtenida de la web. Úsala para responder con precisión, " +
        	"pero mantén tu estilo y personalidad de Merlin. Si algo no está claro o falta info, dilo honestamente:\n\n" +
        	webContext,
      });
    }

    messages.push({ role: "user", content: rawText });

    // 6) Call Groq
    const completion = await groq.chat.completions.create({
    	model: GROQ_MODEL,
    	messages,
    	max_tokens: 256,
    	temperature: 0.7,
    });

    console.timeEnd("merlin-mention-groq");

    const replyText =
    	completion.choices[0]?.message?.content?.trim() ??
    	"Merlin tried to answer but something went wrong.";

    await message.reply(replyText);
	} catch (err) {
    console.error("Error in Merlin mention handler:", err);
    await message.reply("Mi núcleo se bugueó un segundo. Intenta otra vez 🧙‍♀️");
	}
});



// Log in with the bot's token.
client.login(BOT_TOKEN);
