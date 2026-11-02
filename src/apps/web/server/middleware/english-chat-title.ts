import { defineEventHandler } from "h3";

import { prepareEnglishChatTitle } from "../agent-output.js";

export default defineEventHandler(prepareEnglishChatTitle);
