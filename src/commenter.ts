/* eslint-disable @typescript-eslint/explicit-function-return-type */
import * as core from '@actions/core'
import * as github from '@actions/github'
import {octokit} from './octokit.js'

const context = github.context
const repo = context.repo

export const COMMENT_GREETING = `:robot: OpenAI`

export const COMMENT_TAG =
  '<!-- This is an auto-generated comment by OpenAI -->'

export const COMMENT_REPLY_TAG =
  '<!-- This is an auto-generated reply by OpenAI -->'

export const SUMMARIZE_TAG =
  '<!-- This is an auto-generated comment: summarize by openai -->'

export const EXTRA_CONTENT_TAG = '<!-- Extra content -->'

export const DESCRIPTION_TAG =
  '<!-- This is an auto-generated comment: release notes by openai -->'
export const DESCRIPTION_TAG_END =
  '<!-- end of auto-generated comment: release notes by openai -->'

export const RAW_SUMMARY_TAG =
  '<!-- This is an auto-generated comment: raw summary by openai -->'
export const RAW_SUMMARY_TAG_END =
  '<!-- end of auto-generated comment: raw summary by openai -->'

export class Commenter {
  /**
   * @param mode Can be "create", "replace". Default is "replace".
   */
  async comment(message: string, tag: string, mode: string) {
    let target: number
    if (context.payload.pull_request) {
      target = context.payload.pull_request.number
    } else if (context.payload.issue) {
      target = context.payload.issue.number
    } else {
      core.warning(
        `Skipped: context.payload.pull_request and context.payload.issue are both null`
      )
      return
    }

    if (!tag) {
      tag = COMMENT_TAG
    }

    const body = `${COMMENT_GREETING}

${message}

${tag}`

    if (mode === 'create') {
      await this.create(body, target)
    } else if (mode === 'replace') {
      await this.replace(body, tag, target)
    } else {
      core.warning(`Unknown mode: ${mode}, use "replace" instead`)
      await this.replace(body, tag, target)
    }
  }

  getContentWithinTags(content: string, startTag: string, endTag: string) {
    const start = content.indexOf(startTag)
    const end = content.indexOf(endTag)
    if (start >= 0 && end >= 0) {
      return content.slice(start + startTag.length, end)
    }
    return ''
  }

  removeContentWithinTags(content: string, startTag: string, endTag: string) {
    const start = content.indexOf(startTag)
    const end = content.indexOf(endTag)
    if (start >= 0 && end >= 0) {
      return content.slice(0, start) + content.slice(end + endTag.length)
    }
    return content
  }

  get_raw_summary(summary: string) {
    const content = this.getContentWithinTags(
      summary,
      RAW_SUMMARY_TAG,
      RAW_SUMMARY_TAG_END
    )
    // remove the first and last line
    const lines = content.split('\n')
    lines.shift()
    lines.pop()
    return lines.join('\n')
  }

  get_description(description: string) {
    return this.removeContentWithinTags(
      description,
      DESCRIPTION_TAG,
      DESCRIPTION_TAG_END
    )
  }

  get_release_notes(description: string) {
    const release_notes = this.getContentWithinTags(
      description,
      DESCRIPTION_TAG,
      DESCRIPTION_TAG_END
    )
    return release_notes.replace(/(^|\n)> .*/g, '')
  }

  async update_description(pull_number: number, message: string) {
    // add this response to the description field of the PR as release notes by looking
    // for the tag (marker)
    try {
      // get latest description from PR
      const pr = await octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number
      })
      let body = ''
      if (pr.data.body) {
        body = pr.data.body
      }
      const description = this.get_description(body)

      // find the tag in the description and replace the content between the tag and the tag_end
      // if not found, add the tag and the content to the end of the description
      const tag_index = description.indexOf(DESCRIPTION_TAG)
      const tag_end_index = description.indexOf(DESCRIPTION_TAG_END)
      const comment = `${DESCRIPTION_TAG}\n${message}\n${DESCRIPTION_TAG_END}`
      if (tag_index === -1 || tag_end_index === -1) {
        const new_description = `${description}\n${comment}`
        await octokit.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number,
          body: new_description
        })
      } else {
        let new_description = description.substring(0, tag_index)
        new_description += comment
        new_description += description.substring(
          tag_end_index + DESCRIPTION_TAG_END.length
        )
        await octokit.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number,
          body: new_description
        })
      }
    } catch (e) {
      core.warning(
        `Failed to get PR: ${e}, skipping adding release notes to description.`
      )
    }
  }

  private reviewCommentsBuffer: {
    path: string
    start_line: number
    end_line: number
    message: string
  }[] = []

  async buffer_review_comment(
    path: string,
    start_line: number,
    end_line: number,
    message: string
  ) {
    message = `${COMMENT_GREETING}

${message}

${COMMENT_TAG}`
    this.reviewCommentsBuffer.push({
      path,
      start_line,
      end_line,
      message
    })
  }

  async submit_review(pull_number: number, commit_id: string) {
    core.info(
      `Submitting review for PR #${pull_number}, total comments: ${this.reviewCommentsBuffer.length}`
    )
    try {
      let commentCounter = 0
      for (const comment of this.reviewCommentsBuffer) {
        core.info(`Posting comment: ${comment.message}`)
        let found = false
        const comments = await this.get_comments_at_range(
          pull_number,
          comment.path,
          comment.start_line,
          comment.end_line
        )
        for (const c of comments) {
          if (c.body.includes(COMMENT_TAG)) {
            core.info(
              `Updating review comment for ${comment.path}:${comment.start_line}-${comment.end_line}: ${comment.message}`
            )
            await octokit.pulls.updateReviewComment({
              owner: repo.owner,
              repo: repo.repo,
              comment_id: c.id,
              body: comment.message
            })
            found = true
            break
          }
        }

        if (!found) {
          core.info(
            `Creating new review comment for ${comment.path}:${comment.start_line}-${comment.end_line}: ${comment.message}`
          )
          const commentData: any = {
            owner: repo.owner,
            repo: repo.repo,
            pull_number,
            commit_id,
            body: comment.message,
            path: comment.path,
            line: comment.end_line
          }

          if (comment.start_line !== comment.end_line) {
            commentData.start_side = 'RIGHT'
            commentData.start_line = comment.start_line
          }

          await octokit.pulls.createReviewComment(commentData)
        }

        commentCounter++
        core.info(
          `Comment ${commentCounter}/${this.reviewCommentsBuffer.length} posted`
        )
      }
    } catch (e) {
      core.warning(`Failed to submit review: ${e}`)
      throw e
    }
  }

  async review_comment_reply(
    pull_number: number,
    top_level_comment: any,
    message: string
  ) {
    const reply = `${COMMENT_GREETING}

${message}

${COMMENT_REPLY_TAG}
`
    try {
      // Post the reply to the user comment
      await octokit.pulls.createReplyForReviewComment({
        owner: repo.owner,
        repo: repo.repo,
        pull_number,
        body: reply,
        comment_id: top_level_comment.id
      })
    } catch (error) {
      core.warning(`Failed to reply to the top-level comment ${error}`)
      try {
        await octokit.pulls.createReplyForReviewComment({
          owner: repo.owner,
          repo: repo.repo,
          pull_number,
          body: `Could not post the reply to the top-level comment due to the following error: ${error}`,
          comment_id: top_level_comment.id
        })
      } catch (e) {
        core.warning(`Failed to reply to the top-level comment ${e}`)
      }
    }
    try {
      if (top_level_comment.body.includes(COMMENT_TAG)) {
        // replace COMMENT_TAG with COMMENT_REPLY_TAG in topLevelComment
        const newBody = top_level_comment.body.replace(
          COMMENT_TAG,
          COMMENT_REPLY_TAG
        )
        await octokit.pulls.updateReviewComment({
          owner: repo.owner,
          repo: repo.repo,
          comment_id: top_level_comment.id,
          body: newBody
        })
      }
    } catch (error) {
      core.warning(`Failed to update the top-level comment ${error}`)
    }
  }

  async get_comments_within_range(
    pull_number: number,
    path: string,
    start_line: number,
    end_line: number
  ) {
    const comments = await this.list_review_comments(pull_number)
    return comments.filter(
      (comment: any) =>
        comment.path === path &&
        comment.body !== '' &&
        ((comment.start_line !== undefined &&
          comment.start_line >= start_line &&
          comment.line <= end_line) ||
          (start_line === end_line && comment.line === end_line))
    )
  }

  async get_comments_at_range(
    pull_number: number,
    path: string,
    start_line: number,
    end_line: number
  ) {
    const comments = await this.list_review_comments(pull_number)
    return comments.filter(
      (comment: any) =>
        comment.path === path &&
        comment.body !== '' &&
        ((comment.start_line !== undefined &&
          comment.start_line === start_line &&
          comment.line === end_line) ||
          (start_line === end_line && comment.line === end_line))
    )
  }

  async get_comment_chains_within_range(
    pull_number: number,
    path: string,
    start_line: number,
    end_line: number,
    tag = ''
  ) {
    const existing_comments = await this.get_comments_within_range(
      pull_number,
      path,
      start_line,
      end_line
    )
    // find all top most comments
    const top_level_comments = []
    for (const comment of existing_comments) {
      if (!comment.in_reply_to_id) {
        top_level_comments.push(comment)
      }
    }

    let all_chains = ''
    let chain_num = 0
    for (const top_level_comment of top_level_comments) {
      // get conversation chain
      const chain = await this.compose_comment_chain(
        existing_comments,
        top_level_comment
      )
      if (chain && chain.includes(tag)) {
        chain_num += 1
        all_chains += `Conversation Chain ${chain_num}:
${chain}
---
`
      }
    }
    return all_chains
  }

  async compose_comment_chain(reviewComments: any[], topLevelComment: any) {
    const conversationChain = reviewComments
      .filter((cmt: any) => cmt.in_reply_to_id === topLevelComment.id)
      .map((cmt: any) => `${cmt.user.login}: ${cmt.body}`)

    conversationChain.unshift(
      `${topLevelComment.user.login}: ${topLevelComment.body}`
    )

    return conversationChain.join('\n---\n')
  }

  async get_comment_chain(pull_number: number, comment: any) {
    try {
      const review_comments = await this.list_review_comments(pull_number)
      const top_level_comment = await this.get_top_level_comment(
        review_comments,
        comment
      )
      const chain = await this.compose_comment_chain(
        review_comments,
        top_level_comment
      )
      return {chain, topLevelComment: top_level_comment}
    } catch (e) {
      core.warning(`Failed to get conversation chain: ${e}`)
      return {
        chain: '',
        topLevelComment: null
      }
    }
  }

  async get_top_level_comment(reviewComments: any[], comment: any) {
    let top_level_comment = comment

    while (top_level_comment.in_reply_to_id) {
      const parent_comment = reviewComments.find(
        (cmt: any) => cmt.id === top_level_comment.in_reply_to_id
      )

      if (parent_comment) {
        top_level_comment = parent_comment
      } else {
        break
      }
    }

    return top_level_comment
  }

  private reviewCommentsCache: Record<number, any[]> = {}

  async list_review_comments(target: number) {
    if (this.reviewCommentsCache[target]) {
      return this.reviewCommentsCache[target]
    }

    const all_comments: any[] = []
    let page = 1
    try {
      for (;;) {
        const {data: comments} = await octokit.pulls.listReviewComments({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: target,
          page,
          per_page: 100
        })
        all_comments.push(...comments)
        page++
        if (!comments || comments.length < 100) {
          break
        }
      }

      this.reviewCommentsCache[target] = all_comments
      return all_comments
    } catch (e) {
      core.warning(`Failed to list review comments: ${e}`)
      return all_comments
    }
  }

  async create(body: string, target: number) {
    try {
      // get commend ID from the response
      await octokit.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: target,
        body
      })
    } catch (e) {
      core.warning(`Failed to create comment: ${e}`)
    }
  }

  async replace(body: string, tag: string, target: number) {
    try {
      const cmt = await this.find_comment_with_tag(tag, target)
      if (cmt) {
        await octokit.issues.updateComment({
          owner: repo.owner,
          repo: repo.repo,
          comment_id: cmt.id,
          body
        })
      } else {
        await this.create(body, target)
      }
    } catch (e) {
      core.warning(`Failed to replace comment: ${e}`)
    }
  }

  async find_comment_with_tag(tag: string, target: number) {
    try {
      const comments = await this.list_comments(target)
      for (const cmt of comments) {
        if (cmt.body && cmt.body.includes(tag)) {
          return cmt
        }
      }

      return null
    } catch (e: unknown) {
      core.warning(`Failed to find comment with tag: ${e}`)
      return null
    }
  }

  private issueCommentsCache: Record<number, any[]> = {}

  async list_comments(target: number) {
    if (this.issueCommentsCache[target]) {
      return this.issueCommentsCache[target]
    }

    const all_comments: any[] = []
    let page = 1
    try {
      for (;;) {
        const {data: comments} = await octokit.issues.listComments({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: target,
          page,
          per_page: 100
        })
        all_comments.push(...comments)
        page++
        if (!comments || comments.length < 100) {
          break
        }
      }

      this.issueCommentsCache[target] = all_comments
      return all_comments
    } catch (e: any) {
      core.warning(`Failed to list comments: ${e}`)
      return all_comments
    }
  }
}
