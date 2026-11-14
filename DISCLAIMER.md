# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-calendly-smart-workload-balancer`) are for educational and architectural demonstration purposes. I publish them as a reference implementation, not as a managed product or a professional service.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts. That includes, without limitation, misrouted or unassigned meetings, meetings assigned to a rep who is on leave, overwritten or incorrect CRM ownership, duplicate calendar events, missed sales opportunities, uneven workloads, and any resulting commercial, contractual, or employment consequences.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. Calendly, HubSpot, and Google Calendar payloads, endpoints, and n8n node parameters change over time; I do not warrant compatibility with any particular version or account configuration.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox, and a test Calendly account and test calendar) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every ownership change and calendar event as something that cannot be undone, and review the routing decisions in dry run before you enable writes.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of Calendly, HubSpot, Google, and any connected services. That includes confirming a lawful basis for processing invitee data and rep availability, limiting PTO calendar access to free/busy information, keeping webhook signing keys and tokens out of source control, verifying every webhook signature, and reviewing every automated ownership change.
* **Workforce & Fairness Decisions:** Routing weights, capacity limits, and working-hours rules affect people's workloads and potentially their compensation. Configure and communicate them in line with your internal policies and applicable employment law. The algorithm is a tool, not a substitute for management judgment.
* **Rate Limits & Availability:** Each booking triggers several HubSpot and Google Calendar API calls. High booking volumes can exhaust rate limits and cause delayed or fallback assignments. Monitor API usage after deployment.

## Limitation of Liability

To the maximum extent permitted by law, in no event shall dhRobin Systems or the author (DH Robin) be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with this software or its use, even if advised of the possibility of such damage.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-calendly-smart-workload-balancer/blob/main/LICENSE).

---

DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
