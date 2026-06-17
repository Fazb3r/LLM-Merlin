// src/commands/admin/backup.ts
import {
  SlashCommandBuilder,
  CommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import path from "path";
import fs from "fs";

// Only Faiber's Discord ID can use this command
const AUTHORIZED_USER_ID = process.env.OWNER_DISCORD_ID ?? "";

const dbPath = path.resolve(process.cwd(), "src/data/merlin.db");

export const data = new SlashCommandBuilder()
  .setName("backup")
  .setDescription("Descarga una copia de la base de datos de Merlin. Solo para el creador.");

export async function execute(interaction: CommandInteraction) {
  // Check authorization
  if (interaction.user.id !== AUTHORIZED_USER_ID) {
    await interaction.reply({
      content: "No tienes permiso para usar este comando.",
      ephemeral: true,
    });
    return;
  }

  // Check if DB file exists
  if (!fs.existsSync(dbPath)) {
    await interaction.reply({
      content: "No se encontró el archivo de base de datos.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const attachment = new AttachmentBuilder(dbPath, {
      name: `merlin_backup_${new Date().toISOString().split("T")[0]}.db`,
      description: "Copia de seguridad de la base de datos de Merlin",
    });

    await interaction.editReply({
      content: "Aquí tienes la copia de la base de datos 💛",
      files: [attachment],
    });
  } catch (err) {
    console.error("[BACKUP] Error sending DB file:", err);
    await interaction.editReply({
      content: "Algo falló al intentar enviar el archivo.",
    });
  }
}
