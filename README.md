# Police---DC-Bot
A discord bot to give warnings to users, and to remove the warnings after a set time

# Commands

## Warning:
- **/warn:** Gives a warning to a user.
- **/unwarn:** Manually removes a warning from the user.
- **/mywarnings:** Shows you how much time is left on your warnings.

## Config:
- **/config:** Config the warning levels by matching them to roles and setting how long they take to expire.
- **/accessconfig:** Config what role is needed to access mod commands like /warn and /config.
- **/viewconfig:** Shows your current warning configuration.

## Escalation:
- **/escalation set:** Configure how many level X warnings you need to automatically bump up to a level Y.
- **/escalation remove:** Removes an escalation step.
- **/escalation setcap:** Sets the cap of the warnings, where any additional warning won't escalate.
- **/escalation removecap:** Removes the escalation cap.
- **/escalation view:** Shows the current escalation setup.

## Moderation:
- **/history:** Shows the warning history of a specific user.
- **/warnlist:** Shows all active warning in the server.
