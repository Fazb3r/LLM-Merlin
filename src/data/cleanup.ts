// src/data/cleanup.ts
import Database from "better-sqlite3";
import path from "path";

const dbPath = path.resolve(process.cwd(), "src/data/merlin.db");
console.log("[CLEANUP] Connecting to database at:", dbPath);

const db = new Database(dbPath);

/* ---------------------------------------------------------
 * TERM VALIDATION GUARDS (Duplicated from teachingDetector.ts for self-containment)
 * --------------------------------------------------------- */

function isValidTerm(term: string): boolean {
  if (!term || term.length < 3 || term.length > 50) return false;

  // Reject if it contains a Discord mention
  if (/<@!?\d+>/.test(term)) return false;

  // Reject if it starts with a pronoun, article, or question word
  const badStarters =
    /^(el|la|los|las|un|una|mi|tu|su|sus|esto|eso|aqui|ahi|alla|que|como|quien|donde|cuando|por|para|con|sin|y|o|pero|mas|muy|si|no|merlin|mer|ya|hay|hoy|ser|estar|tiene|tengo|yo|me|te|le|nos|vos|usted)\b/i;
  if (badStarters.test(term.trim())) return false;

  // Reject if it looks like a sentence fragment (has punctuation or multiple clauses)
  if (/[,!?;:]/.test(term)) return false;

  return true;
}

function isValidDefinition(def: string): boolean {
  if (!def || def.trim().length < 5) return false;
  // Need at least 2 words
  if (def.trim().split(/\s+/).length < 2) return false;
  // Reject if it contains a Discord mention as the whole thing
  if (/^<@!?\d+>$/.test(def.trim())) return false;
  return true;
}

// Check for --dry-run
const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log("[CLEANUP] RUNNING IN DRY-RUN MODE - NO CHANGES WILL BE SAVED");
} else {
  console.log("[CLEANUP] RUNNING IN WRITE MODE - GARBAGE ROWS WILL BE DELETED");
}

try {
  // Get all rows
  const rows = db.prepare("SELECT * FROM server_lexicon").all() as any[];
  console.log(`[CLEANUP] Total rows in server_lexicon: ${rows.length}`);

  let cleanCount = 0;
  let garbageCount = 0;
  const toDeleteIds: number[] = [];

  for (const row of rows) {
    const termOk = isValidTerm(row.term);
    const defOk = isValidDefinition(row.definition);

    if (!termOk || !defOk) {
      garbageCount++;
      toDeleteIds.push(row.id);
      
      const reasons: string[] = [];
      if (!termOk) {
        if (!row.term) reasons.push("empty term");
        else if (row.term.length < 3) reasons.push(`term too short (${row.term.length})`);
        else if (row.term.length > 50) reasons.push(`term too long (${row.term.length})`);
        else if (/<@!?\d+>/.test(row.term)) reasons.push("term contains Discord mention");
        else if (/^(el|la|los|las|un|una|mi|tu|su|sus|esto|eso|aqui|ahi|alla|que|como|quien|donde|cuando|por|para|con|sin|y|o|pero|mas|muy|si|no|merlin|mer|ya|hay|hoy|ser|estar|tiene|tengo|yo|me|te|le|nos|vos|usted)\b/i.test(row.term.trim())) {
          reasons.push("term starts with pronoun/article/stopword");
        }
        else if (/[,!?;:]/.test(row.term)) reasons.push("term contains punctuation");
      }
      if (!defOk) {
        if (!row.definition) reasons.push("empty definition");
        else if (row.definition.trim().length < 5) reasons.push("definition too short");
        else if (row.definition.trim().split(/\s+/).length < 2) reasons.push("definition is a single word");
        else if (/^<@!?\d+>$/.test(row.definition.trim())) reasons.push("definition is only a Discord mention");
      }

      console.log(`[GARBAGE] ID: ${row.id} | Term: "${row.term}" | Def: "${row.definition}" | Taught By: ${row.taught_by_username || row.taught_by} | Reason: ${reasons.join(", ")}`);
    } else {
      cleanCount++;
    }
  }

  console.log(`\n[CLEANUP] Summary:\n - Clean rows: ${cleanCount}\n - Garbage rows: ${garbageCount}`);

  if (toDeleteIds.length > 0) {
    if (dryRun) {
      console.log(`[CLEANUP] Dry-run: would have deleted ${toDeleteIds.length} rows.`);
    } else {
      console.log(`[CLEANUP] Deleting ${toDeleteIds.length} rows...`);
      const deleteStmt = db.prepare("DELETE FROM server_lexicon WHERE id = ?");
      
      const transaction = db.transaction((ids: number[]) => {
        for (const id of ids) {
          deleteStmt.run(id);
        }
      });
      
      transaction(toDeleteIds);
      console.log("[CLEANUP] Deletion complete!");
    }
  } else {
    console.log("[CLEANUP] No garbage rows found to delete.");
  }
} catch (error) {
  console.error("[CLEANUP] Error during cleanup:", error);
} finally {
  db.close();
}
