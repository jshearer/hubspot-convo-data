import { Document, IDerivation, SourceEnrichWithChatGPT } from "flow/estuary/jshearer/hubspot-thread-enrichments/v1.ts";
import { OpenAI } from "https://raw.githubusercontent.com/ChuckJonas/openai-deno/chat-function-support/mod.ts";
import { pLimit } from "https://deno.land/x/p_limit@v1.0.0/mod.ts";

const openAIKey = "-- Your key here --";
const openAI = new OpenAI(openAIKey);

const schema = {
    "type": "object",
    "properties": {
        "is_relevant": {
            "type": "boolean",
            "description":
                "True if this thread is directly with someone who is a sales prospect. False for any other kind of conversation, such as those with investors, internal conversations, or introductions to other people.",
        },
        "probability_to_close": {
            "type": "string",
            "description":
                "This field indicates how likely it is that a successful deal will be closed with this prospect. If this is not a conversation with a prospective customer, use 'not_applicable'",
            "enum": ["never", "probably_not", "possibly", "likely", "almost_certain", "not_applicable"],
        },
        "probability_to_churn": {
            "type": "string",
            "description":
                "This field indicates how likely it is that an existing customer will churn (leave, stop being a customer). If this is not a conversation with an existing customer, use 'not applicable'.",
            "enum": ["never", "probably_not", "possibly", "likely", "almost_certain", "not_applicable"],
        },
        "overview": {
            "type": "string",
            "description": "An overview of this conversation summarizing useful and relevant information",
        },
        "helpful_info": {
            "type": "string",
            "description":
                "Any real, truthful information that would be helpful to a salesperson who has the goal of closing this prospect, be as specific as possible. If you can't extract any sufficiently useful data, say 'none' instead of guessing.",
        },
        "sentiment": {
            "type": "string",
            "description": "How is the subject of this conversation feeling about us?",
            "enum": ["very negative", "negative", "neutral", "positive", "very positive"],
        },
        "customer_stage": {
            "type": "string",
            "description": "What stage of the sales funnel is this person in? If it's not extremely clear, report as unknown.",
            "enum": ["reached_out", "heard_back", "meeting_scheduled", "intent_to_close", "closed", "unknown"],
        },
    },
    "required": ["is_relevant", "overview", "sentiment", "helpful_info", "customer_stage", "probability_to_close", "probability_to_churn"],
};

const limiter = pLimit(3);

// Implementation for derivation estuary/jshearer/salesforce-testing-nonrealtime/comms-enrichment/v1.
export class Derivation extends IDerivation {
    pending: Promise<Document>[];

    constructor(open: { state: unknown }) {
        super(open);
        this.pending = [];
    }

    enrichWithChatGPT(read: { doc: SourceEnrichWithChatGPT }): Document[] {
        this.pending.push(limiter(() => executePrompt(read.doc)));
        return [];
    }

    // Await all previously-started completions and output them.
    async flush(): Promise<Document[]> {
        const out = [];
        for (const pending of this.pending) {
            out.push(await pending);
        }
        this.pending.length = 0; // Reset for next transaction.
        return out;
    }
}

function extractUsefulData(input: { [key: string]: any }, fields: string[]): string {
    return Object.entries(input)
        .filter(([k, v]) => v != null && fields.includes(k))
        .map(([k, v]) => `${k}: "${v}"`).join(", ");
}

function convertToText(doc: SourceEnrichWithChatGPT): string {
    const companies_metadata = doc.companies?.map((company) =>
        extractUsefulData(
            company?.properties ?? {},
            [
                "name",
                "description",
                "address",
                "city",
                "country",
                "domain",
                "founded_year",
            ].reverse(),
        )
    );

    const messages = doc.messages?.map(({ properties }) => {
        let txt = (properties?.hs_email_text || "")
            .replace(/(\r)/gm, "\n")
            .replace(/\n+/gm, "\n")
            .trim();

        const first_quote_line = txt.split("\n").findIndex((line) => line.trim().startsWith("On ") && line.trim().endsWith("wrote:"));

        if (first_quote_line > 0) {
            txt = txt.split("\n").slice(0, first_quote_line).join("\n");
        }

        return `From: ${properties?.hs_email_from_firstname} ${properties?.hs_email_from_lastname} <${properties?.hs_email_from_email}>
To: ${properties?.hs_email_to_firstname} ${properties?.hs_email_to_lastname} <${properties?.hs_email_to_email}>
Date: ${properties?.hs_createdate}
${
            txt
                .split("\n")
                .filter(
                    (line) => !(line.trim().startsWith(">")),
                ).map((line) => `\t${line}`)
                .join("\n")
        }`;
    }) ?? [];

    return `${
        companies_metadata
            ? `Participant Organizations:
${companies_metadata.map((m) => `- ${m}`).join("\n")}
`
            : ""
    }
Converastion History:
${
        messages
            .reverse()
            .map((msg, id) =>
                msg
                    .split("\n")
                    .map((line) => `${id + 1}: ${line}`)
                    .join("\n")
            ).join("\n\n")
    }`;
}

async function executePrompt(doc: SourceEnrichWithChatGPT): Promise<Document> {
    const prompt = convertToText(doc);

    const subject = doc.messages?.[0]?.properties?.hs_email_subject?.toLowerCase()?.replace(/re: /g, "");
    const companies = doc.companies?.map((c) => c?.properties?.name).join(", ");

    let est_tokens = prompt.length / 4;

    if (est_tokens < 3000) {
        const chatCompletion = await openAI.createChatCompletion({
            model: "gpt-3.5-turbo-0613",
            messages: [{
                "role": "system",
                "content":
                    "You are a helpful assistant working for Estuary. When extracting useful information, try to imagine why someone might find that piece of data useful. For example, providing a contact's email address is probably not useful since that information is already displayed elsewhere.",
            }, {
                role: "user",
                content: `Extract information from this conversation useful to a sales or support-person:
        ${prompt}`,
            }],
            //@ts-ignore
            functions: [{ "name": "set_conversation_info", "parameters": schema }],
            function_call: { "name": "set_conversation_info" },
            temperature: 0.1,
        });

        let parsed_enrichment;
        try {
            parsed_enrichment = JSON.parse(chatCompletion.choices[0].message.function_call?.arguments ?? "null");
        } catch (e) {
            parsed_enrichment = { unparsable: chatCompletion.choices[0].message.function_call?.arguments };
        }

        return {
            id: doc.id,
            enrichments: parsed_enrichment,
            subject,
            companies,
        };
    } else {
        return {
            id: doc.id,
            //@ts-ignore
            skip: "too_long",
            subject,
            companies,
        };
    }
}
