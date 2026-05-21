# Police---DC-Bot
A discord bot to give warnings to users, and to remove the warnings after a set time

# Commands

## Warning:
- **/warn:** Gives a warning to a user.
- **/unwarn:** Manually removes a warning from the user.
- **/timeout:** Gives a configurable length timeout to a user.
- **/kick:** Kicks the user
- **/ban:** Bans the user and deletes their messages in the last (configurable time). Can also be set to unban after set time.
- **/unban:** Unbans the user.
- **/mywarnings:** Shows you how much time is left on your warnings.

## Config:
- **/config set:** Config the warning levels by matching them to roles and setting how long they take to expire.
- **/config access:** Config what role is needed to access mod commands like /warn and /config.
- **/config view:** Shows your current warning configuration.
- **/config remove:** SRemoves a warning level.
- **/config logchannel:** Set the channel where all warning, kick and ban embeds go to.
- **/config removelogchannel:** Removes the log channel.

## Escalation:
- **/escalation set:** Configure how many level X warnings you need to automatically bump up to a level Y.
- **/escalation remove:** Removes an escalation step.
- **/escalation setcap:** Sets the cap of the warnings, where any additional warning won't escalate.
- **/escalation removecap:** Removes the escalation cap.
- **/escalation view:** Shows the current escalation setup.
- **/escalation settimeout:** Adds a special threshold where the user gets a configurable timeout.
- **/escalation removetimeout:** Removes one of the special steps.

## Admin:
- **/history:** Shows the warning history of a specific user.
- **/warnlist:** Shows all active warning in the server.
- **/userinfo:** View account info, roles, active warnings, warn counts per level, kicks, bans, and notes for any user.

## Other

- **/help:** Shows all commands available.
- **/note add:** Adds a note to a user.
- **/note remove:** Removes a note from a user.
- **/note view:** Views all of the users notes.
