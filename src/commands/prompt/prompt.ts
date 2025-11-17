import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import Queue from "../../queue/queue";

const queue = new Queue();




module.exports = {
	data: new SlashCommandBuilder()
		.setName('prompt')
		.setDescription('Send a prompt to our uncensored llama2')
        .addStringOption(option =>
            option.setName('input')
                .setDescription('The prompt to send')
                .setRequired(true)),
	async execute(interaction: ChatInputCommandInteraction) {
        //We only want this message to show to the user since the thread will be public
        await interaction.deferReply({flags: MessageFlags.Ephemeral});
        queue.addItem(interaction);
	}
};