# DWS Hosted MCP

## User Request (verbatim)

lets start this as a fully new artifact arc

Ive decided to make a hosted mcp for dws exployees to interact with: kinda like the mvp of what we were talking about but a lot simpler.

1. its hosted, with some super simple auth. For now it can be whatever is literally gonna be the simplest to help. Since its a hosted mcp it should work with claude, chatgpt, etc.

Its main tools are 
- load_dws_skill(skill_name) - the different skill descriptions are in the tool description here
- execute_dws_script(script_name) - standalone scripts or skill specific all here, same convention as above

For the mvp, the first skill I want to make is migrate_photos.

Since its hosted, idk what the best way to do this is, but thinking maybe spawning an upload link then doing some kind of human ratification loop, etc. We can get creative here.
Keep in mind, uploads may be humongous. Im talking upwards of 100 gb. This is to support migrating all existing images to the photos.dws-reciepts.com
