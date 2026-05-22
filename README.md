# Police---DC-Bot
A discord bot to give warnings to users, and to remove the warnings after a set time

# Commands

## Moderation:
- **/warning add:** Gives a warning to a user.
- **/warning remove:** Manually removes the selected warning from a user.
- **/timeout add:** Gives a configurable length timeout to a user.
- **/timeout remove:** Remove the timeout from a user.
- **/kick:** Kicks the user
- **/ban add:** Bans the user and deletes their messages in the last (configurable time). Can also be set to unban after set time.
- **/ban remove:** Unbans the user.

## Config:
- **/config set:** Config the warning levels by matching them to roles and setting how long they take to expire.
- **/config access:** Config what role is needed to access mod commands like /warn and /config.
- **/config view:** Shows your current warning configuration.
- **/config remove:** Removes a warning level.
- **/config logchannel:** Set the channel where all warning, kick and ban embeds go to.
- **/config removelogchannel:** Removes the log channel.
- **/config warndm:** Toggles DM's to users on or off.

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
- **/warning list:** Shows all active warning in the server.
- **/userinfo:** View account info, roles, active warnings, warn counts per level, kicks, bans, and notes for any user.

## Notes:
- **/note add:** Adds a note to a user.
- **/note remove:** Removes a note from a user.
- **/note view:** Views all of the users notes.

## Other
- **/help:** Shows all commands available.
- **/mywarnings:** Shows you how much time is left on your warnings.
- **/invite:** Creates an invite for the bot with all the permissions the bot needs.
