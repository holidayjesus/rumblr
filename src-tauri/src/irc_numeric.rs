//! IRC numeric display policy.
//!
//! Servers encode a lot of product-visible state as numerics. Keeping the
//! routing rules here makes them testable without needing a live IRC socket or
//! a Tauri window, which is exactly what we want for service-message and
//! reconnect regression coverage.

use crate::irc_events::{irc_message, server_buffer};
use crate::models::IrcMessage;
use crate::text::clean_irc_display_text;
use irc::client::prelude::Response;

pub(crate) fn display_message_for_numeric(
    response: Response,
    params: &[String],
    server_id: &str,
) -> Option<IrcMessage> {
    match response {
        Response::RPL_LOGGEDIN => Some(service_message(
            server_id,
            "NickServ",
            params
                .last()
                .map(|message| clean_irc_display_text(message))
                .unwrap_or_else(|| "Logged in.".to_string()),
        )),
        Response::RPL_LOGGEDOUT => Some(service_message(
            server_id,
            "NickServ",
            params
                .last()
                .map(|message| clean_irc_display_text(message))
                .unwrap_or_else(|| "Logged out.".to_string()),
        )),
        Response::RPL_SASLSUCCESS => Some(service_message(
            server_id,
            "SASL",
            trailing_text(params, "SASL authentication succeeded."),
        )),
        Response::RPL_SASLMECHS => Some(service_message(
            server_id,
            "SASL",
            format!(
                "Available SASL mechanisms: {}",
                params
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        )),
        Response::ERR_SASLFAIL
        | Response::ERR_SASLTOOLONG
        | Response::ERR_SASLABORT
        | Response::ERR_SASLALREADY
        | Response::ERR_NICKLOCKED => Some(service_message(
            server_id,
            "SASL",
            trailing_text(params, "SASL authentication failed."),
        )),
        Response::RPL_AWAY => Some(target_notice(
            server_id,
            params,
            1,
            "Away",
            format!("Away: {}", trailing_text(params, "User is away.")),
        )),
        Response::RPL_WHOISUSER => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            format!(
                "{} is {}@{} - {}",
                params
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(3)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params.last().cloned().unwrap_or_default()
            ),
        )),
        Response::RPL_WHOISSERVER => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            format!("Server: {}", display_params(params, 2)),
        )),
        Response::RPL_WHOISIDLE => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            format!(
                "Idle: {} seconds",
                params.get(2).cloned().unwrap_or_else(|| "0".to_string())
            ),
        )),
        Response::RPL_WHOISCHANNELS => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            format!("Channels: {}", display_params(params, 2)),
        )),
        Response::RPL_ENDOFWHOIS => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            trailing_text(params, "End of WHOIS."),
        )),
        Response::RPL_WHOISKEYVALUE => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            display_params(params, 2),
        )),
        Response::RPL_TOPIC => channel_message(
            server_id,
            params,
            1,
            format!("Topic: {}", trailing_text(params, "No topic set.")),
        ),
        Response::RPL_TOPICWHOTIME => channel_message(
            server_id,
            params,
            1,
            format!(
                "Topic set by {} at {}.",
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(3)
                    .cloned()
                    .unwrap_or_else(|| "unknown time".to_string())
            ),
        ),
        Response::RPL_NOTOPIC => channel_message(server_id, params, 1, "No topic set."),
        Response::RPL_CHANNELMODEIS => channel_message(
            server_id,
            params,
            1,
            format!(
                "Channel modes: {}",
                params.iter().skip(2).cloned().collect::<Vec<_>>().join(" ")
            ),
        ),
        Response::RPL_BANLIST => channel_message(
            server_id,
            params,
            1,
            format!(
                "Ban mask: {}",
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ),
        Response::RPL_ENDOFBANLIST => channel_message(
            server_id,
            params,
            1,
            trailing_text(params, "End of ban list."),
        ),
        Response::RPL_INVITELIST => channel_message(
            server_id,
            params,
            1,
            format!(
                "Invite mask: {}",
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ),
        Response::RPL_ENDOFINVITELIST => channel_message(
            server_id,
            params,
            1,
            trailing_text(params, "End of invite list."),
        ),
        Response::RPL_EXCEPTLIST => channel_message(
            server_id,
            params,
            1,
            format!(
                "Exception mask: {}",
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ),
        Response::RPL_ENDOFEXCEPTLIST => channel_message(
            server_id,
            params,
            1,
            trailing_text(params, "End of exception list."),
        ),
        Response::RPL_USERHOST => Some(service_message(
            server_id,
            "UserHost",
            format!("Hosts: {}", display_params(params, 1)),
        )),
        Response::RPL_ISON => Some(service_message(
            server_id,
            "ISON",
            format!("Online: {}", display_params(params, 1)),
        )),
        Response::RPL_UNIQOPIS => channel_message(
            server_id,
            params,
            1,
            format!(
                "Channel creator: {}",
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ),
        Response::RPL_SUMMONING => Some(server_status_message(
            server_id,
            trailing_text(params, "Summon request sent."),
        )),
        Response::RPL_WHOREPLY => Some(target_notice(
            server_id,
            params,
            5,
            "WHO",
            format!(
                "{} is {}@{} on {} ({})",
                params
                    .get(5)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(3)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                trailing_text(params, "no real name")
            ),
        )),
        Response::RPL_ENDOFWHO => Some(target_notice(
            server_id,
            params,
            1,
            "WHO",
            trailing_text(params, "End of WHO list."),
        )),
        Response::RPL_LINKS => Some(server_status_message(
            server_id,
            format!("Linked server: {}", display_params(params, 1)),
        )),
        Response::RPL_ENDOFLINKS => Some(server_status_message(
            server_id,
            trailing_text(params, "End of LINKS list."),
        )),
        Response::RPL_INVITING => Some(irc_message(
            server_id,
            channel_param(params, 2).unwrap_or_else(|| server_buffer(server_id)),
            "Invite",
            format!(
                "Inviting {} to {}.",
                channel_param(params, 1).unwrap_or_else(|| "user".to_string()),
                channel_param(params, 2).unwrap_or_else(|| "channel".to_string())
            ),
            "notice",
        )),
        Response::RPL_STATSLINKINFO
        | Response::RPL_STATSCOMMANDS
        | Response::RPL_ENDOFSTATS
        | Response::RPL_STATSUPTIME
        | Response::RPL_STATSOLINE
        | Response::RPL_SERVLIST
        | Response::RPL_SERVLISTEND
        | Response::RPL_TRACECLASS
        | Response::RPL_TRACERECONNECT
        | Response::RPL_TRACELOG
        | Response::RPL_TRACEEND
        | Response::RPL_YOURHOST
        | Response::RPL_CREATED
        | Response::RPL_LUSERCLIENT
        | Response::RPL_LUSEROP
        | Response::RPL_LUSERUNKNOWN
        | Response::RPL_LUSERCHANNELS
        | Response::RPL_LUSERME
        | Response::RPL_LOCALUSERS
        | Response::RPL_GLOBALUSERS
        | Response::RPL_TIME
        | Response::RPL_VERSION
        | Response::RPL_TRYAGAIN
        | Response::RPL_YOUREOPER
        | Response::RPL_REHASHING => Some(server_status_message(
            server_id,
            trailing_text(params, "Server status updated."),
        )),
        Response::RPL_MYINFO => Some(server_status_message(
            server_id,
            format!("Server info: {}", display_params(params, 1)),
        )),
        Response::RPL_ISUPPORT => Some(server_status_message(
            server_id,
            format!(
                "Server features: {}",
                display_params_without_trailing(params, 1)
            ),
        )),
        Response::RPL_BOUNCE => Some(server_status_message(
            server_id,
            format!("Try another server: {}", display_params(params, 1)),
        )),
        Response::RPL_UMODEIS => Some(server_status_message(
            server_id,
            format!("Your user modes: {}", display_params(params, 1)),
        )),
        Response::RPL_NOWAWAY => Some(server_status_message(
            server_id,
            trailing_text(params, "You have been marked away."),
        )),
        Response::RPL_UNAWAY => Some(server_status_message(
            server_id,
            trailing_text(params, "You are no longer marked away."),
        )),
        Response::RPL_WHOISOPERATOR => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            trailing_text(params, "is an IRC operator."),
        )),
        Response::RPL_WHOISCERTFP => Some(target_notice(
            server_id,
            params,
            1,
            "WHOIS",
            format!(
                "Certificate fingerprint: {}",
                params
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        )),
        Response::RPL_WHOWASUSER => Some(target_notice(
            server_id,
            params,
            1,
            "WHOWAS",
            format!(
                "{} was {}@{} - {}",
                params
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(2)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params
                    .get(3)
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                params.last().cloned().unwrap_or_default()
            ),
        )),
        Response::RPL_ENDOFWHOWAS => Some(target_notice(
            server_id,
            params,
            1,
            "WHOWAS",
            trailing_text(params, "End of WHOWAS."),
        )),
        Response::RPL_MONONLINE => Some(service_message(
            server_id,
            "Monitor",
            format!("Online: {}", display_params(params, 1)),
        )),
        Response::RPL_MONOFFLINE => Some(service_message(
            server_id,
            "Monitor",
            format!("Offline: {}", display_params(params, 1)),
        )),
        Response::RPL_MONLIST => Some(service_message(
            server_id,
            "Monitor",
            format!("Watching: {}", display_params(params, 1)),
        )),
        Response::RPL_ENDOFMONLIST => Some(service_message(
            server_id,
            "Monitor",
            trailing_text(params, "End of monitor list."),
        )),
        Response::RPL_ADMINME
        | Response::RPL_ADMINLOC1
        | Response::RPL_ADMINLOC2
        | Response::RPL_ADMINEMAIL
        | Response::RPL_INFO
        | Response::RPL_ENDOFINFO
        | Response::RPL_USERSSTART
        | Response::RPL_USERS
        | Response::RPL_ENDOFUSERS
        | Response::RPL_NOUSERS => Some(server_status_message(
            server_id,
            trailing_text(params, "Server information received."),
        )),
        Response::ERR_NOSUCHNICK
        | Response::ERR_UNKNOWNERROR
        | Response::ERR_NOSUCHSERVER
        | Response::ERR_NOSUCHCHANNEL
        | Response::ERR_CANNOTSENDTOCHAN
        | Response::ERR_TOOMANYCHANNELS
        | Response::ERR_WASNOSUCHNICK
        | Response::ERR_TOOMANYTARGETS
        | Response::ERR_NOSUCHSERVICE
        | Response::ERR_NOORIGIN
        | Response::ERR_UNKNOWNCOMMAND
        | Response::ERR_NORECIPIENT
        | Response::ERR_NOTEXTTOSEND
        | Response::ERR_NOTOPLEVEL
        | Response::ERR_WILDTOPLEVEL
        | Response::ERR_BADMASK
        | Response::ERR_NOMOTD
        | Response::ERR_NOADMININFO
        | Response::ERR_FILEERROR
        | Response::ERR_NONICKNAMEGIVEN
        | Response::ERR_ERRONEOUSNICKNAME
        | Response::ERR_NICKCOLLISION
        | Response::ERR_UNAVAILRESOURCE
        | Response::ERR_USERNOTINCHANNEL
        | Response::ERR_NOTONCHANNEL
        | Response::ERR_USERONCHANNEL
        | Response::ERR_NOLOGIN
        | Response::ERR_SUMMONDISABLED
        | Response::ERR_USERSDISABLED
        | Response::ERR_NOTREGISTERED
        | Response::ERR_NEEDMOREPARAMS
        | Response::ERR_ALREADYREGISTRED
        | Response::ERR_NOPERMFORHOST
        | Response::ERR_PASSWDMISMATCH
        | Response::ERR_YOUREBANNEDCREEP
        | Response::ERR_YOUWILLBEBANNED
        | Response::ERR_KEYSET
        | Response::ERR_CHANNELISFULL
        | Response::ERR_UNKNOWNMODE
        | Response::ERR_INVITEONLYCHAN
        | Response::ERR_BANNEDFROMCHAN
        | Response::ERR_BADCHANNELKEY
        | Response::ERR_BADCHANMASK
        | Response::ERR_NOCHANMODES
        | Response::ERR_BANLISTFULL
        | Response::ERR_CHANOPRIVSNEEDED
        | Response::ERR_NOPRIVILEGES
        | Response::ERR_CANTKILLSERVER
        | Response::ERR_RESTRICTED
        | Response::ERR_UNIQOPPRIVSNEEDED
        | Response::ERR_NOOPERHOST
        | Response::ERR_UMODEUNKNOWNFLAG
        | Response::ERR_USERSDONTMATCH
        | Response::ERR_NOPRIVS
        | Response::ERR_MONLISTFULL
        | Response::ERR_METADATALIMIT
        | Response::ERR_TARGETINVALID
        | Response::ERR_NOMATCHINGKEY
        | Response::ERR_KEYINVALID
        | Response::ERR_KEYNOTSET
        | Response::ERR_KEYNOPERMISSION => Some(irc_message(
            server_id,
            best_error_buffer(params, server_id),
            "Server",
            trailing_text(params, "IRC command failed."),
            "system",
        )),
        _ => fallback_numeric_message(response, params, server_id),
    }
}

fn service_message(server_id: &str, service: &str, content: String) -> IrcMessage {
    irc_message(server_id, service, service, content, "notice")
}

fn server_status_message(server_id: &str, content: String) -> IrcMessage {
    irc_message(
        server_id,
        server_buffer(server_id),
        "Server",
        clean_irc_display_text(&content),
        "system",
    )
}

fn target_notice(
    server_id: &str,
    params: &[String],
    target_index: usize,
    username: &str,
    content: impl Into<String>,
) -> IrcMessage {
    let target = params
        .get(target_index)
        .cloned()
        .unwrap_or_else(|| server_buffer(server_id));
    irc_message(
        server_id,
        target,
        username,
        clean_irc_display_text(&content.into()),
        "notice",
    )
}

fn channel_message(
    server_id: &str,
    params: &[String],
    channel_index: usize,
    content: impl Into<String>,
) -> Option<IrcMessage> {
    let channel = channel_param(params, channel_index)?;
    Some(irc_message(
        server_id,
        channel,
        "Server",
        clean_irc_display_text(&content.into()),
        "system",
    ))
}

fn channel_param(params: &[String], index: usize) -> Option<String> {
    params
        .get(index)
        .filter(|value| value.starts_with('#') || value.starts_with('&'))
        .cloned()
}

fn best_error_buffer(params: &[String], server_id: &str) -> String {
    params
        .iter()
        .skip(1)
        .find(|value| value.starts_with('#') || value.starts_with('&'))
        .cloned()
        .unwrap_or_else(|| server_buffer(server_id))
}

fn display_params(params: &[String], start: usize) -> String {
    let content = params
        .iter()
        .skip(start)
        .map(|value| value.trim_start_matches(':'))
        .collect::<Vec<_>>()
        .join(" ");
    clean_irc_display_text(&content)
}

fn display_params_without_trailing(params: &[String], start: usize) -> String {
    let end = params.len().saturating_sub(1);
    let slice = if start < end {
        &params[start..end]
    } else {
        &[]
    };
    let content = slice
        .iter()
        .map(|value| value.trim_start_matches(':'))
        .collect::<Vec<_>>()
        .join(" ");
    if content.is_empty() {
        trailing_text(params, "none")
    } else {
        clean_irc_display_text(&content)
    }
}

fn trailing_text(params: &[String], fallback: &str) -> String {
    params
        .last()
        .filter(|message| !message.trim().is_empty())
        .map(|message| clean_irc_display_text(message.trim_start_matches(':')))
        .unwrap_or_else(|| fallback.to_string())
}

fn fallback_numeric_message(
    response: Response,
    params: &[String],
    server_id: &str,
) -> Option<IrcMessage> {
    let content = trailing_text(params, "");
    if content.is_empty() || !response.is_error() {
        return None;
    }
    Some(irc_message(
        server_id,
        best_error_buffer(params, server_id),
        "Server",
        content,
        "system",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn nickserv_logged_in_routes_to_service_buffer() {
        let msg = display_message_for_numeric(
            Response::RPL_LOGGEDIN,
            &params(&["me", "RumblrUser", "account", "You are now logged in"]),
            "libera",
        )
        .expect("logged-in numeric should display");

        assert_eq!(msg.channel, "NickServ");
        assert_eq!(msg.username, "NickServ");
        assert_eq!(msg.content, "You are now logged in");
    }

    #[test]
    fn channel_errors_route_to_the_channel_that_failed() {
        let msg = display_message_for_numeric(
            Response::ERR_CANNOTSENDTOCHAN,
            &params(&["me", "#rust", "Cannot send to channel"]),
            "libera",
        )
        .expect("channel error should display");

        assert_eq!(msg.channel, "#rust");
        assert_eq!(msg.username, "Server");
        assert_eq!(msg.content, "Cannot send to channel");
    }

    #[test]
    fn sasl_failures_are_visible_as_service_notices() {
        let msg = display_message_for_numeric(
            Response::ERR_SASLFAIL,
            &params(&["me", "SASL authentication failed"]),
            "libera",
        )
        .expect("SASL failure should display");

        assert_eq!(msg.channel, "SASL");
        assert_eq!(msg.msg_type, "notice");
    }

    #[test]
    fn self_away_numerics_route_to_server_status_buffer() {
        let msg = display_message_for_numeric(
            Response::RPL_NOWAWAY,
            &params(&["me", "You have been marked as being away"]),
            "libera",
        )
        .expect("away status should display");

        assert_eq!(msg.channel, "*libera");
        assert_eq!(msg.username, "Server");
        assert_eq!(msg.content, "You have been marked as being away");
    }

    #[test]
    fn channel_list_numerics_stay_in_their_channel_buffer() {
        let msg = display_message_for_numeric(
            Response::RPL_BANLIST,
            &params(&["me", "#rust", "*!*@example.invalid"]),
            "libera",
        )
        .expect("ban list row should display");

        assert_eq!(msg.channel, "#rust");
        assert_eq!(msg.content, "Ban mask: *!*@example.invalid");
    }

    #[test]
    fn richer_whois_numerics_route_to_the_target_conversation() {
        let msg = display_message_for_numeric(
            Response::RPL_WHOISUSER,
            &params(&["me", "alice", "ident", "host.example", "*", "Alice Example"]),
            "libera",
        )
        .expect("whois user row should display");

        assert_eq!(msg.channel, "alice");
        assert_eq!(msg.username, "WHOIS");
        assert_eq!(msg.content, "alice is ident@host.example - Alice Example");
    }

    #[test]
    fn topic_numerics_route_to_channel_buffer() {
        let msg = display_message_for_numeric(
            Response::RPL_TOPIC,
            &params(&["me", "#rumblr", "Latest topic"]),
            "libera",
        )
        .expect("topic numeric should display");

        assert_eq!(msg.channel, "#rumblr");
        assert_eq!(msg.content, "Topic: Latest topic");
    }

    #[test]
    fn whois_extension_numerics_route_to_the_target_conversation() {
        let msg = display_message_for_numeric(
            Response::RPL_WHOISOPERATOR,
            &params(&["me", "alice", "is an IRC operator"]),
            "libera",
        )
        .expect("whois operator row should display");

        assert_eq!(msg.channel, "alice");
        assert_eq!(msg.username, "WHOIS");
        assert_eq!(msg.content, "is an IRC operator");
    }

    #[test]
    fn monitor_numerics_route_to_monitor_service_buffer() {
        let msg = display_message_for_numeric(
            Response::RPL_MONONLINE,
            &params(&["me", "NickServ,ChanServ"]),
            "libera",
        )
        .expect("monitor updates should display");

        assert_eq!(msg.channel, "Monitor");
        assert_eq!(msg.username, "Monitor");
        assert_eq!(msg.content, "Online: NickServ,ChanServ");
    }
}
