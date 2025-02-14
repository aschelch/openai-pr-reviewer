import * as core from '@actions/core'
import * as github from '@actions/github'
import pLimit from 'p-limit'
import {Bot} from './bot.js'
import {
  Commenter,
  COMMENT_REPLY_TAG,
  EXTRA_CONTENT_TAG,
  RAW_SUMMARY_TAG,
  RAW_SUMMARY_TAG_END,
  SUMMARIZE_TAG
} from './commenter.js'
import {octokit} from './octokit.js'
import {Inputs, Options, Prompts} from './options.js'
import * as tokenizer from './tokenizer.js'

const context = github.context
const repo = context.repo

const ignore_keyword = '@openai: ignore'

export const codeReview = async (
  lightBot: Bot,
  heavyBot: Bot,
  options: Options,
  prompts: Prompts
): Promise<void> => {
  const commenter: Commenter = new Commenter()

  const openai_concurrency_limit = pLimit(options.openai_concurrency_limit)

  if (
    context.eventName !== 'pull_request' &&
    context.eventName !== 'pull_request_target'
  ) {
    core.warning(
      `Skipped: current event is ${context.eventName}, only support pull_request event`
    )
    return
  }
  if (!context.payload.pull_request) {
    core.warning(`Skipped: context.payload.pull_request is null`)
    return
  }

  const inputs: Inputs = new Inputs()
  inputs.title = context.payload.pull_request.title
  if (context.payload.pull_request.body) {
    inputs.description = commenter.get_description(
      context.payload.pull_request.body
    )
    inputs.release_notes = commenter.get_release_notes(
      context.payload.pull_request.body
    )
  }

  // if the description contains ignore_keyword, skip
  if (inputs.description.includes(ignore_keyword)) {
    core.info(`Skipped: description contains ignore_keyword`)
    return
  }

  // as gpt-3.5-turbo isn't paying attention to system message, add to inputs for now
  inputs.system_message = options.system_message

  // get SUMMARIZE_TAG message
  const existing_summarize_cmt = await commenter.find_comment_with_tag(
    SUMMARIZE_TAG,
    context.payload.pull_request.number
  )
  if (existing_summarize_cmt) {
    inputs.raw_summary = commenter.get_raw_summary(existing_summarize_cmt.body)
  }
  const existing_commit_ids_block = getReviewedCommitIdsBlock(
    inputs.raw_summary
  )

  const allCommitIds = await getAllCommitIds()
  // find highest reviewed commit id
  let highest_reviewed_commit_id = ''
  if (existing_commit_ids_block) {
    highest_reviewed_commit_id = getHighestReviewedCommitId(
      allCommitIds,
      getReviewedCommitIds(existing_commit_ids_block)
    )
  }

  if (
    highest_reviewed_commit_id === '' ||
    highest_reviewed_commit_id === context.payload.pull_request.head.sha
  ) {
    core.info(
      `Will review from the base commit: ${context.payload.pull_request.base.sha}`
    )
    highest_reviewed_commit_id = context.payload.pull_request.base.sha
  }

  core.info(`Will review from commit: ${highest_reviewed_commit_id}`)
  // get the list of files changed between the highest reviewed commit
  // and the latest (head) commit
  // use octokit.pulls.compareCommits to get the list of files changed
  // between the highest reviewed commit and the latest (head) commit
  const diff = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: highest_reviewed_commit_id,
    head: context.payload.pull_request.head.sha
  })

  const {files, commits} = diff.data
  if (!files) {
    core.warning(`Skipped: diff.data.files is null`)
    return
  }

  // skip files if they are filtered out
  const filter_selected_files = []
  const filter_ignored_files = []
  for (const file of files) {
    if (!options.check_path(file.filename)) {
      core.info(`skip for excluded path: ${file.filename}`)
      filter_ignored_files.push(file)
    } else {
      filter_selected_files.push(file)
    }
  }

  // find hunks to review
  const filtered_files: (
    | [string, string, string, [number, number, string][]]
    | null
  )[] = await Promise.all(
    filter_selected_files.map(async file => {
      // retrieve file contents
      let file_content = ''
      if (!context.payload.pull_request) {
        core.warning(`Skipped: context.payload.pull_request is null`)
        return null
      }
      try {
        const contents = await octokit.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path: file.filename,
          ref: context.payload.pull_request.base.sha
        })
        if (contents.data) {
          if (!Array.isArray(contents.data)) {
            if (contents.data.type === 'file' && contents.data.content) {
              file_content = Buffer.from(
                contents.data.content,
                'base64'
              ).toString()
            }
          }
        }
      } catch (error) {
        core.warning(`Failed to get file contents: ${error}, skipping.`)
      }

      let file_diff = ''
      if (file.patch) {
        file_diff = file.patch
      }

      const patches: [number, number, string][] = []
      for (const patch of split_patch(file.patch)) {
        const patch_lines = patch_start_end_line(patch)
        if (!patch_lines) {
          continue
        }
        const hunks = parse_patch(patch)
        if (!hunks) {
          continue
        }
        const hunks_str = `
---new_hunk---
\`\`\`
${hunks.new_hunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.old_hunk}
\`\`\`
`
        patches.push([
          patch_lines.new_hunk.start_line,
          patch_lines.new_hunk.end_line,
          hunks_str
        ])
      }
      if (patches.length > 0) {
        return [file.filename, file_content, file_diff, patches]
      } else {
        return null
      }
    })
  )

  // Filter out any null results
  const files_and_changes = filtered_files.filter(file => file !== null) as [
    string,
    string,
    string,
    [number, number, string][]
  ][]

  if (files_and_changes.length === 0) {
    core.error(`Skipped: no files to review`)
    return
  }

  const summaries_failed: string[] = []

  const do_summary = async (
    filename: string,
    file_content: string,
    file_diff: string
  ): Promise<[string, string, boolean] | null> => {
    const ins = inputs.clone()
    if (file_diff.length === 0) {
      core.warning(`summarize: file_diff is empty, skip ${filename}`)
      summaries_failed.push(`${filename} (empty diff)`)
      return null
    }

    ins.filename = filename

    // render prompt based on inputs so far
    let tokens = tokenizer.get_token_count(
      prompts.render_summarize_file_diff(ins)
    )

    const diff_tokens = tokenizer.get_token_count(file_diff)
    if (tokens + diff_tokens > options.light_token_limits.request_tokens) {
      core.info(`summarize: diff tokens exceeds limit, skip ${filename}`)
      summaries_failed.push(`${filename} (diff tokens exceeds limit)`)
      return null
    }

    ins.file_diff = file_diff
    tokens += file_diff.length

    // optionally pack file_content
    if (file_content.length > 0) {
      // count occurrences of $file_content in prompt
      const file_content_count =
        prompts.summarize_file_diff.split('$file_content').length - 1
      const file_content_tokens = tokenizer.get_token_count(file_content)
      if (
        file_content_count > 0 &&
        tokens + file_content_tokens * file_content_count <=
          options.light_token_limits.request_tokens
      ) {
        tokens += file_content_tokens * file_content_count
        ins.file_content = file_content
      }
    }
    // summarize content
    try {
      const [summarize_resp] = await lightBot.chat(
        prompts.render_summarize_file_diff(ins),
        {}
      )

      if (!summarize_resp) {
        core.info('summarize: nothing obtained from openai')
        summaries_failed.push(`${filename} (nothing obtained from openai)`)
        return null
      } else {
        // parse the comment to look for triage classification
        // Format is : [TRIAGE]: <NEEDS_REVIEW or APPROVED>
        // if the change needs review return true, else false
        const triageRegex = /\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/
        const triageMatch = summarize_resp.match(triageRegex)

        if (triageMatch) {
          const triage = triageMatch[1]
          const needs_review = triage === 'NEEDS_REVIEW' ? true : false

          // remove this line from the comment
          const summary = summarize_resp.replace(triageRegex, '').trim()
          core.info(`filename: ${filename}, triage: ${triage}`)
          return [filename, summary, needs_review]
        } else {
          return [filename, summarize_resp, true]
        }
      }
    } catch (error) {
      core.warning(`summarize: error from openai: ${error}`)
      summaries_failed.push(`${filename} (error from openai: ${error})`)
      return null
    }
  }

  const summaryPromises = []
  const skipped_files = []
  for (const [filename, file_content, file_diff] of files_and_changes) {
    if (options.max_files <= 0 || summaryPromises.length < options.max_files) {
      summaryPromises.push(
        openai_concurrency_limit(async () =>
          do_summary(filename, file_content, file_diff)
        )
      )
    } else {
      skipped_files.push(filename)
    }
  }

  const summaries = (await Promise.all(summaryPromises)).filter(
    summary => summary !== null
  ) as [string, string, boolean][]

  if (summaries.length > 0) {
    // join summaries into one in the batches of 20
    // and ask the bot to summarize the summaries
    for (let i = 0; i < summaries.length; i += 20) {
      const summaries_batch = summaries.slice(i, i + 20)
      for (const [filename, summary] of summaries_batch) {
        inputs.raw_summary += `---
${filename}: ${summary}
`
      }
      // ask chatgpt to summarize the summaries
      const prompt = `
Provided below are changesets in this pull request.
The format consists of filename(s) and the summary of changes 
for those files. There is a separator between each changeset.
Your task is to de-deduplicate and group together files with
related/similar changes into a single changeset. Respond with the 
updated changesets using the same format as the input.

${inputs.raw_summary}
`
      const [summarize_resp] = await heavyBot.chat(prompt, {})
      if (!summarize_resp) {
        core.warning('summarize: nothing obtained from openai')
      } else {
        inputs.raw_summary = summarize_resp
      }
    }
  }

  let next_summarize_ids = {}

  // final summary
  const [summarize_final_response, summarize_final_response_ids] =
    await heavyBot.chat(prompts.render_summarize(inputs), next_summarize_ids)
  if (!summarize_final_response) {
    core.info('summarize: nothing obtained from openai')
  } else {
    // final release notes
    next_summarize_ids = summarize_final_response_ids
    const [release_notes_response, release_notes_ids] = await heavyBot.chat(
      prompts.render_summarize_release_notes(inputs),
      next_summarize_ids
    )
    if (!release_notes_response) {
      core.info('release notes: nothing obtained from openai')
    } else {
      next_summarize_ids = release_notes_ids
      inputs.release_notes = release_notes_response.replace(/(^|\n)> .*/g, '')
      let message = '### Summary by OpenAI\n\n'
      message += release_notes_response
      commenter.update_description(context.payload.pull_request.number, message)
    }
  }

  let summarize_comment = `${summarize_final_response}
${RAW_SUMMARY_TAG}
<!--
${inputs.raw_summary}
-->
${RAW_SUMMARY_TAG_END}
${EXTRA_CONTENT_TAG}
---

### Chat with 🤖 OpenAI Bot (\`@openai\`)
- Reply on review comments left by this bot to ask follow-up questions. A review comment is a comment on a diff or a file.
- Invite the bot into a review comment chain by tagging \`@openai\` in a reply.

### Code suggestions
- The bot may make code suggestions, but please review them carefully before committing since the line number ranges may be misaligned. 
- You can edit the comment made by the bot and manually tweak the suggestion if it is slightly off.

---

${
  filter_ignored_files.length > 0
    ? `
<details>
<summary>Files ignored due to filter (${filter_ignored_files.length})</summary>

### Ignored files

* ${filter_ignored_files.map(file => file.filename).join('\n* ')}

</details>
`
    : ''
}

${
  skipped_files.length > 0
    ? `
<details>
<summary>Files not processed due to max files limit (${
        skipped_files.length
      })</summary>

### Not processed

* ${skipped_files.join('\n* ')}

</details>
`
    : ''
}

${
  summaries_failed.length > 0
    ? `
<details>
<summary>Files not summarized due to errors (${
        summaries_failed.length
      })</summary>

### Failed to summarize

* ${summaries_failed.join('\n* ')}

</details>
`
    : ''
}
`

  if (options.summary_only !== true) {
    const files_and_changes_review = files_and_changes.filter(([filename]) => {
      const needs_review =
        summaries.find(
          ([summaryFilename]) => summaryFilename === filename
        )?.[2] ?? true
      return needs_review
    })

    const reviews_skipped = files_and_changes
      .filter(
        ([filename]) =>
          !files_and_changes_review.some(
            ([reviewFilename]) => reviewFilename === filename
          )
      )
      .map(([filename]) => filename)

    // failed reviews array
    const reviews_failed: string[] = []
    const do_review = async (
      filename: string,
      file_content: string,
      patches: [number, number, string][]
    ): Promise<void> => {
      // make a copy of inputs
      const ins: Inputs = inputs.clone()
      ins.filename = filename

      // Pack instructions
      ins.patches += `
Format for changes:
  ---new_hunk---
  \`\`\`
  <new hunk annotated with line numbers>
  \`\`\`

  ---old_hunk---
  \`\`\`
  <old hunk that was replaced by the new hunk above>
  \`\`\`

  ---comment_chains---
  \`\`\`
  <comment chains>
  \`\`\`

  ---end_change_section---
  ...

Important instructions:
- The above format for changes consists of multiple change sections. Each change 
  section consists of a new hunk (annotated with line numbers), an old hunk and 
  optionally, existing comment chains. The line number annotation on each line 
  in the new hunk is of the format \`<line_number><colon><whitespace>\`.  
- Note that the code in the old hunk does not exist anymore as it was replaced 
  by the new hunk. The new hunk is the code that you need to review. Consider 
  the context provided by the old hunk and associated comment chain when reviewing 
  the new hunk.  
- Your task is to do a line by line review of new hunks and point out 
  substantive issues in those line number ranges. For each issue you 
  identify, please provide the exact line number range (inclusive) where 
  the issue occurs.
- Only respond in the below response format (consisting of review
  sections) and nothing else. Each review section must consist of a line 
  number range and a review comment for that line number range. Optionally, 
  you can include a single replacement suggestion snippet and/or multiple 
  new code snippets in the review comment. There's a separator between review 
  sections.
- It's important that line number ranges for each review section must 
  be within the line number range of a specific new hunk. i.e. 
  <start_line_number> must belong to the same hunk as the 
  <end_line_number>. The line number range is sufficient to map your 
  comment to the code changes in GitHub pull request.
- Do not summarize the changes or repeat back provided code in the review 
  comments and only focus on pointing out substantive issues.
- Use Markdown format for review comment text.
- Fenced code blocks must be used for new content and replacement 
  code/text snippets and must not be annotated with line numbers.
- If needed, provide a replacement suggestion using fenced code blocks 
  with the \`suggestion\` as the language identifier. The line number range 
  in the review section must map exactly to the line number range (inclusive) 
  that need to be replaced within a new_hunk.
  For instance, if 2 lines of code in a hunk need to be replaced with 15 lines 
  of code, the line number range must be those exact 2 lines. If an entire hunk 
  need to be replaced with new code, then the line number range must be the 
  entire hunk. Replacement suggestions should be complete units that can be
  directly committed by the user in the GitHub UI.
- Replacement code/text snippets must be complete and correctly 
  formatted. Each replacement suggestion must be provided as a separate review 
  section with relevant line number ranges.  
- If needed, suggest new code using the correct language identifier in the 
  fenced code blocks. These snippets may be added to a different file, such 
  as test cases. Multiple new code snippets are allowed within a single 
  review section.
- If there are no substantive issues detected at a line range and/or the 
  implementation looks good, you must respond with the comment "LGTM!" and 
  nothing else for the respective line range in a review section.
- Reflect on your comments and line number ranges before sending the final 
  response to ensure accuracy of line number ranges and replacement
  snippets.

Response format expected:
  <start_line_number>-<end_line_number>:
  <review comment>
  ---
  <start_line_number>-<end_line_number>:
  <review comment>
  \`\`\`suggestion
  <code/text that replaces everything between start_line_number and end_line_number>
  \`\`\`
  ---
  <start_line_number>-<end_line_number>:
  <review comment>
  \`\`\`<language>
  <new code snippet>
  \`\`\`
  ---
  ...

Example changes:
  ---new_hunk---
  1: def add(x, y):
  2:     z = x+y
  3:     retrn z
  4:
  5: def multiply(x, y):
  6:     return x * y
  
  ---old_hunk---
  def add(x, y):
      return x + y

Example response:
  3-3:
  There's a typo in the return statement.
  \`\`\`suggestion
      return z
  \`\`\`
  ---
  5-6:
  LGTM!
  ---

Changes for review are below:
`

      // calculate tokens based on inputs so far
      let tokens = tokenizer.get_token_count(
        prompts.render_review_file_diff(ins)
      )
      // loop to calculate total patch tokens
      let patches_to_pack = 0
      for (const [, , patch] of patches) {
        const patch_tokens = tokenizer.get_token_count(patch)
        if (tokens + patch_tokens > options.heavy_token_limits.request_tokens) {
          break
        }
        tokens += patch_tokens
        patches_to_pack += 1
      }

      // try packing file_content into this request
      const file_content_count =
        prompts.review_file_diff.split('$file_content').length - 1
      const file_content_tokens = tokenizer.get_token_count(file_content)
      if (
        file_content_count > 0 &&
        tokens + file_content_tokens * file_content_count <=
          options.heavy_token_limits.request_tokens
      ) {
        ins.file_content = file_content
        tokens += file_content_tokens * file_content_count
      }

      let patches_packed = 0
      for (const [start_line, end_line, patch] of patches) {
        if (!context.payload.pull_request) {
          core.warning('No pull request found, skipping.')
          continue
        }
        // see if we can pack more patches into this request
        if (patches_packed >= patches_to_pack) {
          core.info(
            `unable to pack more patches into this request, packed: ${patches_packed}, to pack: ${patches_to_pack}`
          )
          break
        }
        patches_packed += 1

        let comment_chain = ''
        try {
          const all_chains = await commenter.get_comment_chains_within_range(
            context.payload.pull_request.number,
            filename,
            start_line,
            end_line,
            COMMENT_REPLY_TAG
          )

          if (all_chains.length > 0) {
            core.info(`Found comment chains: ${all_chains} for ${filename}`)
            comment_chain = all_chains
          }
        } catch (e: any) {
          core.warning(
            `Failed to get comments: ${e}, skipping. backtrace: ${e.stack}`
          )
        }
        // try packing comment_chain into this request
        const comment_chain_tokens = tokenizer.get_token_count(comment_chain)
        if (
          tokens + comment_chain_tokens >
          options.heavy_token_limits.request_tokens
        ) {
          comment_chain = ''
        } else {
          tokens += comment_chain_tokens
        }

        ins.patches += `
${patch}
`
        if (comment_chain !== '') {
          ins.patches += `
---comment_chains---
\`\`\`
${comment_chain}
\`\`\`
`
        }

        ins.patches += `
---end_change_section---
`
      }

      // perform review
      try {
        const [response] = await heavyBot.chat(
          prompts.render_review_file_diff(ins),
          {}
        )
        if (!response) {
          core.info('review: nothing obtained from openai')
          reviews_failed.push(`${filename} (no response)`)
          return
        }
        // parse review
        const reviews = parseReview(response, patches, options.debug)
        for (const review of reviews) {
          // check for LGTM
          if (
            !options.review_comment_lgtm &&
            (review.comment.includes('LGTM') ||
              review.comment.includes('looks good to me'))
          ) {
            continue
          }
          if (!context.payload.pull_request) {
            core.warning('No pull request found, skipping.')
            continue
          }

          try {
            await commenter.buffer_review_comment(
              filename,
              review.start_line,
              review.end_line,
              `${review.comment}`
            )
          } catch (e: any) {
            reviews_failed.push(`${filename} comment failed (${e})`)
          }
        }
      } catch (e: any) {
        core.warning(`Failed to review: ${e}, skipping. backtrace: ${e.stack}`)
        reviews_failed.push(`${filename} (${e})`)
      }
    }

    const reviewPromises = []
    for (const [
      filename,
      file_content,
      ,
      patches
    ] of files_and_changes_review) {
      if (options.max_files <= 0 || reviewPromises.length < options.max_files) {
        reviewPromises.push(
          openai_concurrency_limit(async () =>
            do_review(filename, file_content, patches)
          )
        )
      } else {
        skipped_files.push(filename)
      }
    }

    await Promise.all(reviewPromises)

    summarize_comment += `
${
  reviews_failed.length > 0
    ? `<details>
<summary>Files not reviewed due to errors in this run (${
        reviews_failed.length
      })</summary>

### Failed to review

* ${reviews_failed.join('\n* ')}

</details>
`
    : ''
}

${
  reviews_skipped.length > 0
    ? `<details>
<summary>Files not reviewed due to simple changes (${
        reviews_skipped.length
      })</summary>

### Skipped review

* ${reviews_skipped.join('\n* ')}

</details>
`
    : ''
}
`
    // add existing_comment_ids_block with latest head sha
    summarize_comment += `\n${addReviewedCommitId(
      existing_commit_ids_block,
      context.payload.pull_request.head.sha
    )}`
  }

  // post the final summary comment
  await commenter.comment(`${summarize_comment}`, SUMMARIZE_TAG, 'replace')

  // post the review
  await commenter.submit_review(
    context.payload.pull_request.number,
    commits[commits.length - 1].sha
  )
}

const split_patch = (patch: string | null | undefined): string[] => {
  if (!patch) {
    return []
  }

  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@).*$/gm

  const result: string[] = []
  let last = -1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(patch)) !== null) {
    if (last === -1) {
      last = match.index
    } else {
      result.push(patch.substring(last, match.index))
      last = match.index
    }
  }
  if (last !== -1) {
    result.push(patch.substring(last))
  }
  return result
}

const patch_start_end_line = (
  patch: string
): {
  old_hunk: {start_line: number; end_line: number}
  new_hunk: {start_line: number; end_line: number}
} | null => {
  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@)/gm
  const match = pattern.exec(patch)
  if (match) {
    const old_begin = parseInt(match[2])
    const old_diff = parseInt(match[3])
    const new_begin = parseInt(match[4])
    const new_diff = parseInt(match[5])
    return {
      old_hunk: {
        start_line: old_begin,
        end_line: old_begin + old_diff - 1
      },
      new_hunk: {
        start_line: new_begin,
        end_line: new_begin + new_diff - 1
      }
    }
  } else {
    return null
  }
}

const parse_patch = (
  patch: string
): {old_hunk: string; new_hunk: string} | null => {
  const hunkInfo = patch_start_end_line(patch)
  if (!hunkInfo) {
    return null
  }

  const old_hunk_lines: string[] = []
  const new_hunk_lines: string[] = []

  //let old_line = hunkInfo.old_hunk.start_line
  let new_line = hunkInfo.new_hunk.start_line

  const lines = patch.split('\n').slice(1) // Skip the @@ line

  // Remove the last line if it's empty
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (const line of lines) {
    if (line.startsWith('-')) {
      old_hunk_lines.push(`${line.substring(1)}`)
      //old_line++
    } else if (line.startsWith('+')) {
      new_hunk_lines.push(`${new_line}: ${line.substring(1)}`)
      new_line++
    } else {
      old_hunk_lines.push(`${line}`)
      new_hunk_lines.push(`${new_line}: ${line}`)
      //old_line++
      new_line++
    }
  }

  return {
    old_hunk: old_hunk_lines.join('\n'),
    new_hunk: new_hunk_lines.join('\n')
  }
}

interface Review {
  start_line: number
  end_line: number
  comment: string
}

function parseReview(
  response: string,
  patches: [number, number, string][],
  debug = false
): Review[] {
  const reviews: Review[] = []

  const lines = response.split('\n')
  const lineNumberRangeRegex = /(?:^|\s)(\d+)-(\d+):\s*$/
  const commentSeparator = '---'

  let currentStartLine: number | null = null
  let currentEndLine: number | null = null
  let currentComment = ''
  function storeReview(): void {
    if (currentStartLine !== null && currentEndLine !== null) {
      const sanitizedComment = sanitizeComment(currentComment.trim())
      const review: Review = {
        start_line: currentStartLine,
        end_line: currentEndLine,
        comment: sanitizedComment.trim()
      }

      let within_patch = false
      let best_patch_start_line = patches[0][0]
      let best_patch_end_line = patches[0][1]
      let max_intersection = 0

      for (const [start_line, end_line] of patches) {
        const intersection_start = Math.max(review.start_line, start_line)
        const intersection_end = Math.min(review.end_line, end_line)
        const intersection_length = Math.max(
          0,
          intersection_end - intersection_start + 1
        )

        if (intersection_length > max_intersection) {
          max_intersection = intersection_length
          best_patch_start_line = start_line
          best_patch_end_line = end_line
          within_patch =
            intersection_length === review.end_line - review.start_line + 1
        }

        if (within_patch) break
      }

      if (!within_patch) {
        review.comment = `> Note: This review was outside of the patch, so it was mapped to the patch with the greatest overlap. Original lines [${review.start_line}-${review.end_line}]

${review.comment}`
        review.start_line = best_patch_start_line
        review.end_line = best_patch_end_line
      }

      reviews.push(review)

      core.info(
        `Stored comment for line range ${currentStartLine}-${currentEndLine}: ${currentComment.trim()}`
      )
    }
  }

  function sanitizeComment(comment: string): string {
    const suggestionStart = '```suggestion'
    const suggestionEnd = '```'
    const lineNumberRegex = /^ *(\d+): /gm

    let suggestionStartIndex = comment.indexOf(suggestionStart)

    while (suggestionStartIndex !== -1) {
      const suggestionEndIndex = comment.indexOf(
        suggestionEnd,
        suggestionStartIndex + suggestionStart.length
      )

      if (suggestionEndIndex === -1) break

      const suggestionBlock = comment.substring(
        suggestionStartIndex + suggestionStart.length,
        suggestionEndIndex
      )
      const sanitizedBlock = suggestionBlock.replace(lineNumberRegex, '')

      comment =
        comment.slice(0, suggestionStartIndex + suggestionStart.length) +
        sanitizedBlock +
        comment.slice(suggestionEndIndex)

      suggestionStartIndex = comment.indexOf(
        suggestionStart,
        suggestionStartIndex +
          suggestionStart.length +
          sanitizedBlock.length +
          suggestionEnd.length
      )
    }

    return comment
  }

  for (const line of lines) {
    const lineNumberRangeMatch = line.match(lineNumberRangeRegex)

    if (lineNumberRangeMatch) {
      storeReview()
      currentStartLine = parseInt(lineNumberRangeMatch[1], 10)
      currentEndLine = parseInt(lineNumberRangeMatch[2], 10)
      currentComment = ''
      if (debug) {
        core.info(
          `Found line number range: ${currentStartLine}-${currentEndLine}`
        )
      }
      continue
    }

    if (line.trim() === commentSeparator) {
      storeReview()
      currentStartLine = null
      currentEndLine = null
      currentComment = ''
      if (debug) {
        core.info('Found comment separator')
      }
      continue
    }

    if (currentStartLine !== null && currentEndLine !== null) {
      currentComment += `${line}\n`
    }
  }

  storeReview()

  return reviews
}

const commit_ids_marker_start = '<!-- commit_ids_reviewed_start -->'
const commit_ids_marker_end = '<!-- commit_ids_reviewed_end -->'

// function that takes a comment body and returns the list of commit ids that have been reviewed
// commit ids are comments between the commit_ids_reviewed_start and commit_ids_reviewed_end markers
// <!-- [commit_id] -->
function getReviewedCommitIds(commentBody: string): string[] {
  const start = commentBody.indexOf(commit_ids_marker_start)
  const end = commentBody.indexOf(commit_ids_marker_end)
  if (start === -1 || end === -1) {
    return []
  }
  const ids = commentBody.substring(start + commit_ids_marker_start.length, end)
  // remove the <!-- and --> markers from each id and extract the id and remove empty strings
  return ids
    .split('<!--')
    .map(id => id.replace('-->', '').trim())
    .filter(id => id !== '')
}

// get review commit ids comment block from the body as a string
// including markers
function getReviewedCommitIdsBlock(commentBody: string): string {
  const start = commentBody.indexOf(commit_ids_marker_start)
  const end = commentBody.indexOf(commit_ids_marker_end)
  if (start === -1 || end === -1) {
    return ''
  }
  return commentBody.substring(start, end + commit_ids_marker_end.length)
}

// add a commit id to the list of reviewed commit ids
// if the marker doesn't exist, add it
function addReviewedCommitId(commentBody: string, commitId: string): string {
  const start = commentBody.indexOf(commit_ids_marker_start)
  const end = commentBody.indexOf(commit_ids_marker_end)
  if (start === -1 || end === -1) {
    return `${commentBody}\n${commit_ids_marker_start}\n<!-- ${commitId} -->\n${commit_ids_marker_end}`
  }
  const ids = commentBody.substring(start + commit_ids_marker_start.length, end)
  return `${commentBody.substring(
    0,
    start + commit_ids_marker_start.length
  )}${ids}<!-- ${commitId} -->\n${commentBody.substring(end)}`
}

// given a list of commit ids provide the highest commit id that has been reviewed
function getHighestReviewedCommitId(
  commitIds: string[],
  reviewedCommitIds: string[]
): string {
  for (let i = commitIds.length - 1; i >= 0; i--) {
    if (reviewedCommitIds.includes(commitIds[i])) {
      return commitIds[i]
    }
  }
  return ''
}

async function getAllCommitIds(): Promise<string[]> {
  const allCommits = []
  let page = 1
  let commits
  if (context && context.payload && context.payload.pull_request) {
    do {
      commits = await octokit.pulls.listCommits({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: context.payload.pull_request.number,
        per_page: 100,
        page
      })

      allCommits.push(...commits.data.map(commit => commit.sha))
      page++
    } while (commits.data.length > 0)
  }

  return allCommits
}
