---
name: webgym-single-task-design-
description: Get a task description, use this skill to build a web gym static html web site,  give a full PRD for the frontend design.
---


## Theme Choice 

Here is the list of the most popular UI design themes and aesthetic trends dominating 2025 and moving into 2026, categorized by their visual style and function.

### **The "Big 5" Dominant Aesthetics**

These are the most immediately recognizable visual styles currently shaping the web and mobile apps.

1. **Bento Grids** – Inspired by Japanese lunch boxes, this modular layout breaks content into distinct, rectangular compartments (boxes) for a clean, organized, and highly scannable interface. (Popularized by Apple and Linear).
2. **Glassmorphism** – Uses translucent, frosted-glass effects (background blur) to create depth and hierarchy. It makes elements look like they are floating on floating glass sheets.
3. **Neubrutalism (Neo-Brutalism)** – A rebellion against standard "pretty" design. It features high-contrast colors, bold black outlines, unpolished "raw" aesthetics, and idiosyncratic typography.
4. **Dark Mode (Standardized)** – No longer just a toggle, this is now a primary theme. Modern dark mode uses "dark grey" surfaces (rather than pure black) with desaturated accents to reduce eye strain and save battery.
5. **Clean Minimalism (Hyper-Minimalism)** – An evolution of flat design that focuses on extreme simplicity, massive usage of whitespace, and removing all non-essential elements to focus strictly on content.

### **Texture & Depth Themes**

These themes move away from "flat" design to add tactile realism and dimension.

6. **Liquid Glass / Molten Metal** – An advanced variation of Glassmorphism that adds fluid, organic, and metallic textures, often animated to look like flowing mercury or water.
7. **Claymorphism (Fluffy 3D)** – Combines 3D geometry with soft, pastel colors and rounded corners. It looks like friendly, inflated clay models (often used in Web3 and startup branding).
8. **Skeuomorphism 2.0** – A modern return to realistic textures (leather, wood, switches) but applied subtly to specific elements like toggles or music knobs, rather than the entire interface.
9. **Atmospheric Gradients** – Using soft, moving, and blurred color blobs (aurora borealis effects) as backgrounds to create a mood without cluttering the screen.
10. **Immersive 3D / Spatial UI** – Interfaces designed with depth in mind, preparing for AR/VR (Vision Pro era). Elements react to cursor movement or maintain spatial awareness.

### **Typography & Layout Driven**

Themes where text and structure take precedence over images.

11. **Typographic Heavy / Text-First** – Treating text as the primary visual element. Massive, bold fonts are used not just to read, but to create graphical structure and fill the screen.
12. **Scrollytelling** – A narrative theme where the interface changes and animates specifically based on the user's scroll behavior, turning a static page into an interactive story.
13. **Card UI (Modular)** – The standard for mobile: breaking all information into individual "cards" (like Pinterest or Google Now) for easy swiping and rearranging.
14. **Asymmetrical Layouts** – Breaking the traditional grid system intentionally to create dynamic, energetic, and unexpected visual flows.

### **Emerging & Tech-Focused**

Themes driven by new capabilities in AI and hardware.

15. **Generative UI (AI-Adaptive)** – Interfaces that change their layout, color, or content density dynamically based on the user's past behavior (e.g., a dashboard that re-arranges itself).
16. **Voice User Interface (VUI) / Zero UI** – Interfaces designed to be invisible, relying on voice commands, gestures, or haptics rather than buttons and screens.
17. **Eco-Friendly / Sustainable Web** – A "Low Energy" aesthetic using darker colors, standard system fonts, and vector graphics to reduce the carbon footprint of data transfer.
18. **Micro-Interaction Focused** – A theme where the "personality" comes entirely from small animations (buttons changing shape, icons winking) rather than static graphics.
19. **Retro / Y2K Nostalgia** – Pixel art, neon colors, and glitch effects reminiscent of the late 90s and early 2000s web.
20. **Pastel Pop** – Soft, candy-colored palettes paired with rounded geometric shapes, often used to make complex SaaS or financial apps feel friendly and approachable.


# The agent reward

** IMPORTANT **:
This is an Agent Game with a binary reward signal.

Reward Policy:

Return reward = 1.0 if and only if the agent successfully completes all required objectives.

Return reward = 0.0, or no reward, if the agent fails or partially completes the task.

Success Condition:
Success is defined as meeting all task requirements completely, correctly, and unambiguously.

Success Feedback:
Upon success, the system must trigger Lset and display a highly visible and engaging Success page that clearly communicates task completion and provides positive reinforcement.


# About randomness

Given a specific task the game must don't have randomness, you can set a seed.

# Synthesis tasks

Create a script to generation synthesis tasks about 10 samples per task, using jsonl with the following format.

```
{ "task_name": find_recipe,  "task_id": 0, "query": "Find a recipe for more than 100 review in the website", "task_resource": {} }
```

Synthesis tasks with the above jsonl, save the data in the website subdirectory a static resources. Put the task specific resouces in `task_resource` for judgement.

When the webagent visit a website with task_i, localate the specific task for each website, and use the task_resouce to validate the action of agent.

# Writing the PRD

- The PRD should include Style Choice
- The full description of the task

