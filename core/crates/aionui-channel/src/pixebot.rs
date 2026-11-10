//! Typed chat commands: `/pixebot <name>` points a chat at one of the user's
//! Pixebots (assistants) instead of the platform default; `/new` goes back.

/// A chat command the channel handles itself instead of sending it to the agent.
#[derive(Debug, PartialEq, Eq)]
pub enum ChatCommand<'a> {
    /// `/pixebot <name>`; the name is empty when none was given.
    Pixebot(&'a str),
    /// `/new`: a fresh session on the platform's default agent.
    NewSession,
}

/// The command in `text`, if it is one the channel handles.
pub fn parse_chat_command(text: &str) -> Option<ChatCommand<'_>> {
    let text = text.trim();
    let (head, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    // Telegram group chats send `/command@BotName`.
    let command = head.split_once('@').map_or(head, |(command, _)| command);
    let rest = rest.trim();
    match command.to_ascii_lowercase().as_str() {
        "/pixebot" => Some(ChatCommand::Pixebot(rest)),
        "/new" if rest.is_empty() => Some(ChatCommand::NewSession),
        _ => None,
    }
}

/// The Pixebot named `name` (ignoring case and surrounding spaces) among `(assistant_id, name)` pairs.
pub fn find_pixebot<'a>(pixebots: &'a [(String, String)], name: &str) -> Option<&'a (String, String)> {
    let wanted = name.trim().to_lowercase();
    pixebots
        .iter()
        .find(|(_, pixebot)| pixebot.trim().to_lowercase() == wanted)
}

/// The reply listing the user's Pixebots; `asked` is the name that did not match, or empty.
pub fn pixebot_list_text(pixebots: &[(String, String)], asked: &str) -> String {
    let mut names: Vec<&str> = pixebots.iter().map(|(_, name)| name.trim()).collect();
    names.sort_unstable_by_key(|name| name.to_lowercase());
    names.dedup();
    if names.is_empty() {
        return "You have no Pixebots yet. Create one in Pixebot Browser.".to_owned();
    }
    let header = if asked.is_empty() {
        "Send /pixebot <name> to chat with one of your Pixebots:".to_owned()
    } else {
        format!("No Pixebot named \"{asked}\". Your Pixebots:")
    };
    let lines: Vec<String> = names.iter().map(|name| format!("• {name}")).collect();
    format!("{header}\n{}", lines.join("\n"))
}

/// The confirmation sent once the chat is talking to `name`.
pub fn pixebot_selected_text(name: &str) -> String {
    format!("Now chatting with {name}. Send /new to go back to the default agent.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixebots() -> Vec<(String, String)> {
        vec![
            ("a-1".to_owned(), "Sales Bot".to_owned()),
            ("a-2".to_owned(), "Researcher".to_owned()),
        ]
    }

    #[test]
    fn parses_pixebot_with_name() {
        assert_eq!(
            parse_chat_command("/pixebot  Sales Bot "),
            Some(ChatCommand::Pixebot("Sales Bot"))
        );
    }

    #[test]
    fn parses_telegram_bot_suffix_and_case() {
        assert_eq!(
            parse_chat_command("/PixeBot@MyBot researcher"),
            Some(ChatCommand::Pixebot("researcher"))
        );
        assert_eq!(parse_chat_command("/new@MyBot"), Some(ChatCommand::NewSession));
    }

    #[test]
    fn parses_pixebot_without_name() {
        assert_eq!(parse_chat_command("/pixebot"), Some(ChatCommand::Pixebot("")));
    }

    #[test]
    fn leaves_other_text_for_the_agent() {
        assert_eq!(parse_chat_command("hello /pixebot x"), None);
        assert_eq!(parse_chat_command("/pixebots"), None);
        assert_eq!(parse_chat_command("/new idea for the page"), None);
        assert_eq!(parse_chat_command("/help"), None);
    }

    #[test]
    fn finds_pixebot_ignoring_case() {
        let list = pixebots();
        assert_eq!(find_pixebot(&list, "sales bot").map(|(id, _)| id.as_str()), Some("a-1"));
        assert!(find_pixebot(&list, "sales").is_none());
    }

    #[test]
    fn lists_names_sorted_with_unknown_name() {
        let text = pixebot_list_text(&pixebots(), "Ghost");
        assert_eq!(
            text,
            "No Pixebot named \"Ghost\". Your Pixebots:\n• Researcher\n• Sales Bot"
        );
    }

    #[test]
    fn lists_names_when_none_asked() {
        assert!(pixebot_list_text(&pixebots(), "").starts_with("Send /pixebot <name>"));
        assert_eq!(
            pixebot_list_text(&[], "x"),
            "You have no Pixebots yet. Create one in Pixebot Browser."
        );
    }
}
