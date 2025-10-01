#!/usr/bin/env -S deno run --allow-env --allow-net --allow-run

/**
 * Deno CLI to get a Jira ticket's details.
 *
 * This script can fetch the latest "In Progress" ticket, a specific ticket by ID,
 * or prompt the user to select from a list. It can provide full details, a
 * formatted git branch name, or a JSON object. It can also open a ticket in
 * the browser based on the current git branch, a specified ticket ID, or an
 * interactive selection.
 *
 * Required permissions (for `deno compile`):
 * --allow-net: To make network requests to the Jira API.
 * --allow-env: To access environment variables for Jira credentials.
 * --allow-run=git,open,xdg-open,cmd: To run git commands and open URLs in the browser.
 *
 * Usage:
 * # Show help
 * jira.ts
 *
 * # Get information about the current user
 * jira.ts me
 *
 * # Open ticket from current git branch in browser
 * jira.ts open
 *
 * It is recommended to set the following environment variables:
 * JIRA_USER_EMAIL: Your Jira account email address.
 * JIRA_API_TOKEN: Your Jira API token.
 * JIRA_BASE_URL: The base URL of your Jira instance (e.g., https://your-domain.atlassian.net).
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts"
import * as colors from "https://deno.land/std@0.224.0/fmt/colors.ts"

// --- Interfaces for type safety ---
interface JiraIssue {
  key: string
  fields: {
    summary: string
    updated: string
  }
}

interface JiraApiResponse {
  issues: JiraIssue[]
}

interface JiraUserGroup {
  name: string
  self: string
}

interface JiraUserGroups {
  size: number
  items: JiraUserGroup[]
}

interface JiraUser {
  accountId: string
  emailAddress: string
  displayName: string
  active: boolean
  groups: JiraUserGroups
  // Note: Job Title is not a standard field in the Jira REST API /myself response.
}

interface JiraIssueCreateResponse {
  id: string
  key: string
  self: string
}

interface JiraTransition {
  id: string
  name: string
  to: {
    name: string
  }
}

// --- Console Output Styling ---
let plainOutput = false
const style = {
  bold: (str: string) => (plainOutput ? str : colors.bold(str)),
  italic: (str: string) => (plainOutput ? str : colors.italic(str)),
  error: (str: string) => (plainOutput ? str : colors.bold(colors.red(str))),
  success: (str: string) => (plainOutput ? str : colors.bold(colors.green(str))),
  info: (str: string) => (plainOutput ? str : colors.cyan(str)),
  warning: (str: string) => (plainOutput ? str : colors.yellow(str)),
  dim: (str: string) => (plainOutput ? str : colors.dim(str)),
  heading: (str: string) => (plainOutput ? str : colors.bold(colors.underline(colors.cyan(str)))),
}

// --- Jira API Client ---
class JiraClient {
  private baseUrl: string
  private headers: Headers

  constructor(baseUrl: string, email: string, token: string) {
    this.baseUrl = baseUrl
    this.headers = new Headers({
      Authorization: `Basic ${btoa(`${email}:${token}`)}`,
      Accept: "application/json",
    })
  }

  private async request<T>(
    endpoint: string,
    options: { method?: string; body?: unknown; errorMessage: string }
  ): Promise<T | null> {
    const { method = "GET", body = null, errorMessage } = options
    const fetchOptions: RequestInit = {
      method,
      headers: this.headers,
    }
    if (body) {
      this.headers.set("Content-Type", "application/json")
      fetchOptions.body = JSON.stringify(body)
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, fetchOptions)
      if (!response.ok) {
        console.error(`${style.error("❌ Error:")} ${errorMessage}: ${response.status} ${response.statusText}`)
        const errorBody = await response.text()
        console.error("Error Body:", errorBody)
        return null
      }
      if (response.status === 204) {
        // No Content
        return null
      }
      return (await response.json()) as T
    } catch (error) {
      console.error(`❌ ${style.error("An unexpected network error occurred:")}`, error)
      return null
    }
  }

  async getSelf(): Promise<JiraUser | null> {
    return await this.request<JiraUser>("/rest/api/3/myself?expand=groups", {
      errorMessage: "Error fetching user information",
    })
  }

  async getTicketById(ticketId: string): Promise<JiraIssue | null> {
    const endpoint = `/rest/api/3/issue/${ticketId}?fields=summary,updated`
    return await this.request<JiraIssue>(endpoint, {
      errorMessage: `Error fetching ticket ${ticketId}`,
    })
  }

  async getAllAssignedTickets(): Promise<JiraIssue[] | null> {
    const jql = 'assignee = currentUser() AND status = "In Progress" ORDER BY updated DESC'
    const endpoint = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,updated`
    const result = await this.request<JiraApiResponse>(endpoint, { errorMessage: "Error fetching assigned tickets" })
    return result ? result.issues : null
  }

  async createTicket(
    projectKey: string,
    summary: string,
    issueTypeName: string,
    assigneeAccountId: string | null
  ): Promise<JiraIssueCreateResponse | null> {
    const body = {
      fields: {
        project: {
          key: projectKey,
        },
        summary: summary,
        issuetype: {
          name: issueTypeName,
        },
        assignee: assigneeAccountId ? { accountId: assigneeAccountId } : undefined,
      },
    }

    return await this.request<JiraIssueCreateResponse>("/rest/api/3/issue", {
      method: "POST",
      body,
      errorMessage: "Error creating ticket",
    })
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[] | null> {
    const result = await this.request<{ transitions: JiraTransition[] }>(`/rest/api/3/issue/${issueKey}/transitions`, {
      errorMessage: `Error fetching transitions for ${issueKey}`,
    })
    return result ? result.transitions : null
  }

  async transitionTicket(issueKey: string, transitionId: string): Promise<boolean> {
    const headers = new Headers(this.headers)
    headers.set("Content-Type", "application/json")
    try {
      const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ transition: { id: transitionId } }),
      })
      if (response.ok) {
        return true
      }
      console.error(
        `${style.error("❌ Error:")} Error transitioning ticket ${issueKey}: ${response.status} ${response.statusText}`
      )
      const errorBody = await response.text()
      if (errorBody) {
        console.error("Error Body:", errorBody)
      }
      return false
    } catch (error) {
      console.error(`❌ ${style.error("An unexpected network error occurred:")}`, error)
      return false
    }
  }
}

/**
 * Prints the help message for the CLI tool.
 */
function printHelp() {
  console.log(`
${style.bold("📋 Jira CLI Tool")}

${style.italic("A command-line interface to interact with Jira tickets.")}

${style.heading("USAGE:")}
  ${style.info("jira.ts <command> [options]")}

${style.heading("COMMANDS:")}
  ${style.info("ticket")}        Fetch details for a specific or the latest ticket.
  ${style.info("git-branch")}    Generate a git branch name from a ticket.
  ${style.info("open")}          Open a ticket in the browser. Uses --interactive, --id, or the current git branch.
  ${style.info("create")}        Create a new Jira ticket.
  ${style.info("me")}            Display information about the current Jira user.
  ${style.info("help")}          Show this help message.

${style.heading("OPTIONS:")}
  ${style.info("--id=<id>")}              Specify a ticket ID (e.g., "PROJ-123").
                         ${style.dim("(For: ticket, git-branch, open)")}

  ${style.info("--interactive")}          Choose a ticket from a list of your "In Progress" tickets.
                         ${style.dim("(For: ticket, git-branch, open)")}

  ${style.info("--json")}                 Output details as JSON.
                         ${style.dim("(For: ticket, me)")}

  ${style.info("--checkout")}             Checkout the git branch. If the branch doesn't exist, it will be created.
                         ${style.dim("(For: git-branch, create)")}

  ${style.info("-s, --suffix=<suffix>")}  Provide a custom suffix for the branch name, overriding the ticket summary.
                         ${style.dim("(For: git-branch, create)")}

  ${style.info("-o, --open")}             Open the ticket in the browser after creation.
                         ${style.dim("(For: create)")}

  ${style.info("-p, --project=<key>")}    The project key for the new ticket (e.g., "PROJ").
                         ${style.dim("(For: create)")}

  ${style.info("-t, --title=<title>")}    The title for the new ticket.
                         ${style.dim("(For: create)")}

  ${style.info("--issuetype=<type>")}     The type of the ticket (e.g., "Task", "Story"). Defaults to "Task".
                         ${style.dim("(For: create)")}

  ${style.info("--plain")}                Display plain text output without colors or styles.

${style.heading("GLOBAL OPTIONS:")}
  ${style.info("--email=<email>")}        Your Jira email. (Env: JIRA_USER_EMAIL)
  ${style.info("--token=<token>")}        Your Jira API token. (Env: JIRA_API_TOKEN)
  ${style.info("--baseUrl=<url>")}        Your Jira instance URL. (Env: JIRA_BASE_URL)
    `)
}

/**
 * Normalizes a string to be git-friendly for a branch name.
 * @param text - The text to normalize.
 * @returns A normalized string.
 */
function normalizeForBranchName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove non-alphanumeric, allowing spaces/hyphens
    .replace(/\s+/g, "-") // Replace spaces with a hyphen
    .replace(/-+/g, "-") // Replace multiple hyphens with one
}

/**
 * Generates a git-friendly branch name from a Jira issue, truncated to 255 characters.
 * @param issue - The Jira issue object.
 * @param suffix - An optional suffix to use instead of the issue summary.
 * @returns A formatted string for a git branch name (e.g., "PROJ-123-fix-the-bug").
 */
function generateGitBranchName(issue: JiraIssue, suffix?: string): string {
  const key = issue.key
  const content = suffix ? suffix : issue.fields.summary
  let normalizedContent = normalizeForBranchName(content)

  const prefix = `${key}-`
  const maxLength = 255

  let branchName = `${prefix}${normalizedContent}`

  if (branchName.length > maxLength) {
    const availableLength = maxLength - prefix.length
    normalizedContent = normalizedContent.substring(0, availableLength)
  }

  branchName = `${prefix}${normalizedContent}`.replace(/-$/, "") // Final cleanup

  return branchName
}

/**
 * Gets the current git branch name.
 * @returns The current branch name or null if not in a git repository.
 */
async function getCurrentBranchName(): Promise<string | null> {
  try {
    const command = new Deno.Command("git", {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
    })
    const { code, stdout, stderr } = await command.output()
    if (code === 0) {
      return new TextDecoder().decode(stdout).trim()
    } else {
      console.error(`${style.error("❌ Error getting git branch name:")} ${new TextDecoder().decode(stderr)}`)
      return null
    }
  } catch (_error) {
    console.error(style.error(`❌ Failed to execute git command. Are you in a git repository?`))
    return null
  }
}

/**
 * Checks out a git branch, creating it if it doesn't exist.
 * @param branchName - The name of the branch to checkout.
 */
async function checkoutBranch(branchName: string) {
  // First, check if the branch exists
  const checkCmd = new Deno.Command("git", { args: ["rev-parse", "--verify", branchName] })
  const { code: checkCode } = await checkCmd.output()

  const branchExists = checkCode === 0

  let gitCmd: Deno.Command
  if (branchExists) {
    console.log(`✅ ${style.info(`Branch '${branchName}' already exists. Checking it out...`)}`)
    gitCmd = new Deno.Command("git", { args: ["checkout", branchName] })
  } else {
    console.log(`✨ ${style.info(`Branch '${branchName}' does not exist. Creating and checking it out...`)}`)
    gitCmd = new Deno.Command("git", { args: ["checkout", "-b", branchName] })
  }

  const { code, stderr } = await gitCmd.output()
  if (code === 0) {
    console.log(style.success(`✅ Successfully checked out branch: '${branchName}'`))
  } else {
    console.error(`${style.error("❌ Error checking out branch:")} ${new TextDecoder().decode(stderr).trim()}`)
  }
}

/**
 * Opens a URL in the default web browser.
 * @param url - The URL to open.
 */
async function openInBrowser(url: string) {
  let command: string
  let args: string[]

  switch (Deno.build.os) {
    case "darwin":
      command = "open"
      args = [url]
      break
    case "linux":
      command = "xdg-open"
      args = [url]
      break
    case "windows":
      command = "cmd"
      args = ["/c", "start", url.replace(/&/g, "^&")]
      break
    default:
      console.error(`${style.error("❌ Unsupported OS:")} ${Deno.build.os}. Please open this URL manually:\n${url}`)
      return
  }

  try {
    const openCommand = new Deno.Command(command, { args })
    const { code, stderr } = await openCommand.output()
    if (code !== 0) {
      console.error(`${style.error("❌ Error opening browser:")} ${new TextDecoder().decode(stderr)}`)
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`${style.error("❌ Failed to execute command to open browser:")} ${error.message}`)
    } else {
      throw error
    }
  }
}

/**
 * Main function to run the CLI.
 */
async function main() {
  const flags = parse(Deno.args, {
    string: ["email", "token", "baseUrl", "id", "title", "project", "issuetype", "suffix"],
    boolean: ["checkout", "interactive", "json", "plain", "open"],
    alias: { t: "title", o: "open", p: "project", s: "suffix" },
  })

  plainOutput = flags.plain

  const command = flags._[0] as string | undefined

  if (command === undefined || command === "help") {
    printHelp()
    return
  }

  const email = flags.email || Deno.env.get("JIRA_USER_EMAIL")
  const token = flags.token || Deno.env.get("JIRA_API_TOKEN")
  const baseUrl = flags.baseUrl || Deno.env.get("JIRA_BASE_URL")

  if (!email || !token || !baseUrl) {
    console.error(
      style.error("❌ Missing required credentials.") +
        ` Provide as args (--email, --token, --baseUrl) or set env vars (JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL).`
    )
    return
  }

  const client = new JiraClient(baseUrl, email, token)

  // --- Handle `me` subcommand ---
  if (command === "me") {
    console.log(style.info("👤 Fetching your user information..."))
    const user = await client.getSelf()
    if (user) {
      if (flags.json) {
        console.log(JSON.stringify(user, null, 2))
      } else {
        console.log(`\n${style.heading("Your Jira User Information")}`)
        console.log(`   ${style.bold("Display Name:")} ${user.displayName}`)
        console.log(`   ${style.bold("Email:")}        ${user.emailAddress}`)
        console.log(`   ${style.bold("Account ID:")}   ${style.dim(user.accountId)}`)
        console.log(`   ${style.bold("Active:")}       ${user.active ? style.success("Yes") : style.error("No")}`)
        if (user.groups && user.groups.items.length > 0) {
          console.log(`   ${style.bold("Teams/Groups:")} ${user.groups.items.map((g) => g.name).join(", ")}`)
        }
        console.log(style.dim("-------------------------------------------"))
      }
    }
    return
  }

  // --- Handle `create` subcommand ---
  if (command === "create") {
    const title = flags.title
    const project = flags.project
    const issueType = flags.issueType || "Task"

    if (!title || !project) {
      console.error(
        style.error("❌ Missing required arguments for 'create' command. --title and --project are required.")
      )
      return
    }

    console.log(style.info(`✨ Creating new Jira ticket in project ${project}...`))

    // Get self to assign ticket to self by default
    const self = await client.getSelf()
    const assigneeId = self?.accountId ?? null

    const newTicketInfo = await client.createTicket(project, title, issueType, assigneeId)

    if (newTicketInfo) {
      console.log(style.success(`✅ Successfully created ticket ${newTicketInfo.key}`))

      if (flags.checkout) {
        console.log(style.info(`- Attempting to set status to 'In Progress'...`))
        const transitions = await client.getTransitions(newTicketInfo.key)
        if (transitions) {
          const inProgressTransition = transitions.find((t) => t.to.name === "In Progress")
          if (inProgressTransition) {
            const success = await client.transitionTicket(newTicketInfo.key, inProgressTransition.id)
            if (success) {
              console.log(style.success(`- Status successfully set to 'In Progress'.`))
            } else {
              console.error(style.error(`- Failed to transition status to 'In Progress'.`))
            }
          } else {
            console.warn(
              style.warning("- Could not find 'In Progress' transition for this ticket. Please update status manually.")
            )
          }
        } else {
          console.error(style.error(`- Failed to fetch transitions for ticket.`))
        }
      }

      if (flags.open) {
        const url = `${baseUrl}/browse/${newTicketInfo.key}`
        console.log(style.info(`➡️  Opening ticket ${style.bold(newTicketInfo.key)} in your browser...`))
        await openInBrowser(url)
      }

      if (flags.checkout) {
        const tempIssue: JiraIssue = {
          key: newTicketInfo.key,
          fields: {
            summary: title,
            updated: "", // not used by generateGitBranchName
          },
        }
        const branchName = generateGitBranchName(tempIssue, flags.suffix)
        await checkoutBranch(branchName)
      }
    }
    return
  }

  // --- Handle `open` subcommand ---

  if (command === "open") {
    let ticketToOpenId: string | null = null

    if (flags.interactive) {
      console.log(style.info('🔍 Fetching all your assigned "In Progress" tickets...'))
      const allTickets = await client.getAllAssignedTickets()
      if (allTickets && allTickets.length > 0) {
        console.log(`\n${style.bold("👉 Please select a ticket to open:")}`)
        allTickets.forEach((t, index) => {
          console.log(`${style.info(`${index + 1}.`)} ${style.bold(t.key)}: ${t.fields.summary}`)
        })
        const selection = prompt("Enter ticket number:")
        if (selection) {
          const selectedIndex = parseInt(selection, 10) - 1
          if (selectedIndex >= 0 && selectedIndex < allTickets.length) {
            ticketToOpenId = allTickets[selectedIndex].key
          } else {
            console.error(style.error("❌ Invalid selection."))
            return
          }
        } else {
          console.log(style.warning("👋 Selection cancelled."))
          return
        }
      } else {
        console.log(style.warning('🤷 No assigned "In Progress" tickets found.'))
        return
      }
    } else if (flags.id) {
      ticketToOpenId = flags.id
    } else {
      const branchName = await getCurrentBranchName()
      if (branchName) {
        const ticketIdRegex = /^([A-Z]+-\d+)/
        const match = branchName.match(ticketIdRegex)
        if (match && match[1]) {
          ticketToOpenId = match[1]
        } else {
          console.error(
            style.error(
              `❌ Could not extract a Jira ticket ID from branch name: '${branchName}'.\nPlease use --interactive or --id.`
            )
          )
        }
      }
    }

    if (ticketToOpenId) {
      const url = `${baseUrl}/browse/${ticketToOpenId}`
      console.log(style.info(`➡️  Opening ticket ${style.bold(ticketToOpenId)} in your browser...`))
      await openInBrowser(url)
    }
    return
  }

  // --- Handle `ticket` and `git-branch` subcommands ---
  if (command === "ticket" || command === "git-branch") {
    const ticketId = flags["id"]
    let ticket: JiraIssue | null = null

    if (flags.interactive) {
      console.log(style.info('🔍 Fetching all your assigned "In Progress" tickets...'))
      const allTickets = await client.getAllAssignedTickets()
      if (allTickets && allTickets.length > 0) {
        console.log(`\n${style.bold("👉 Please select a ticket:")}`)
        allTickets.forEach((t, index) => {
          console.log(`${style.info(`${index + 1}.`)} ${style.bold(t.key)}: ${t.fields.summary}`)
        })
        const selection = prompt("Enter ticket number:")
        if (selection) {
          const selectedIndex = parseInt(selection, 10) - 1
          if (selectedIndex >= 0 && selectedIndex < allTickets.length) {
            ticket = allTickets[selectedIndex]
          } else {
            console.error(style.error("❌ Invalid selection."))
            return
          }
        } else {
          console.log(style.warning("👋 Selection cancelled."))
          return
        }
      } else {
        console.log(style.warning('🤷 No assigned "In Progress" tickets found.'))
        return
      }
    } else if (ticketId) {
      if (command === "ticket") console.log(style.info(`🔍 Fetching Jira ticket: ${style.bold(ticketId)}...`))
      ticket = await client.getTicketById(ticketId)
    } else {
      if (command === "ticket") console.log(style.info(`⏳ Fetching your latest assigned "In Progress" Jira ticket...`))
      const latestTickets = await client.getAllAssignedTickets()
      if (latestTickets && latestTickets.length > 0) {
        ticket = latestTickets[0]
      }
    }

    // --- Handle output ---
    if (ticket) {
      if (command === "git-branch") {
        const branchName = generateGitBranchName(ticket, flags.suffix)
        if (flags.checkout) {
          await checkoutBranch(branchName)
        } else {
          console.log(branchName)
        }
      } else {
        // command === 'ticket'
        if (flags.json) {
          console.log(JSON.stringify(ticket, null, 2))
        } else {
          console.log(`\n${style.heading(`Jira Ticket Details: ${ticket.key}`)}`)
          console.log(`   ${style.bold("Summary:")} ${ticket.fields.summary}`)
          console.log(`   ${style.bold("Updated:")} ${new Date(ticket.fields.updated).toLocaleString()}`)
          console.log(`   ${style.bold("Link:")}    ${style.dim(baseUrl + "/browse/" + ticket.key)}`)
          console.log(style.dim("-------------------------------------------"))
        }
      }
    } else if (!flags.interactive) {
      const errorMsg = ticketId
        ? `Could not find ticket with ID '${ticketId}'.`
        : 'Could not find any assigned "In Progress" tickets.'
      console.log(`\n${style.info(`ℹ️  ${errorMsg}`)}`)
    }
    return
  }

  // --- Handle unknown command ---
  console.error(`\n${style.error(`❌ Error: Unknown command '${command}'.`)}`)
  printHelp()
}

if (import.meta.main) {
  main()
}
