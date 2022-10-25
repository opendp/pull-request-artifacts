import * as fs from 'fs';
import * as core from '@actions/core'
import {context} from '@actions/github';
import {Octokit} from '@octokit/rest';
import path from 'path';

async function run(): Promise<void> {
    try {
        let commit_sha = core.getInput('commit', {required: true})
        let local_token = core.getInput('repo-token', {required: true})
        let artifact_list = core.getInput('artifacts', {required: true})
        let artifacts_token = core.getInput('artifacts-token', {required: false})
        let artifacts_owner_and_repo = core.getInput('artifacts-repo', {required: false})
        let artifacts_branch = core.getInput('artifacts-branch', {required: false})
        let artifacts_dir = core.getInput('artifacts-dir', {required: false})
        let inter_link = core.getInput('inter-link', {required: false}) == "true"
        let post_comment = core.getInput('post-comment', {required: false}) == "true"
        let title = core.getInput('title', {required: false})

        if (!artifacts_token) {
            artifacts_token = local_token
        }

        let artifacts_owner = context.repo.owner
        let artifacts_repo = context.repo.repo
        if (artifacts_owner_and_repo) {
            [artifacts_owner, artifacts_repo] = artifacts_owner_and_repo.split('/', 2)
        }

        const local_octokit = new Octokit({
            auth: local_token,
            log: {
                debug: core.debug,
                info: core.info,
                warn: core.warning,
                error: core.error,
            },
        })

        const artifacts_octokit = new Octokit({
            auth: artifacts_token,
            log: {
                debug: core.debug,
                info: core.info,
                warn: core.warning,
                error: core.error,
            },
        })

        if (!artifacts_branch) {
            const repo = await artifacts_octokit.rest.repos.get({
                owner: artifacts_owner,
                repo: artifacts_repo,
            })
            artifacts_branch = repo.data.default_branch
        }

        core.info(`Artifacts repo: ${artifacts_owner}/${artifacts_repo}`)
        core.info(`Artifacts branch: ${artifacts_branch}`)

        const findComment = async (body: string): Promise<number | null> => {
            const comments = await local_octokit.rest.issues.listComments({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
            });

            for (let i = 0; i < comments.data.length; i++) {
                const comment = comments.data[i]

                if (!comment.user || comment.user.login != 'github-actions[bot]') {
                    continue
                }

                if (!comment.body || !comment.body.includes(body)) {
                    continue
                }

                return comment.id
            }

            return null
        }

        const updateComment = async (comment_id: number, body: string): Promise<void> => {
            core.info(`Updating comment ${comment_id}`)

            await local_octokit.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: comment_id,
                body,
            })
        }

        const createComment = async (body: string): Promise<void> => {
            core.info(`Posting new comment`)

            await local_octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
            })
        }

        const findFileSha = async (filename: string): Promise<string | undefined> => {
            let file_path = path.join(artifacts_dir, filename)
            try {
                const files = await artifacts_octokit.rest.repos.getContent({
                    owner: artifacts_owner,
                    repo: artifacts_repo,
                    path: path.dirname(file_path),
                    ref: artifacts_branch,
                })


                if (Array.isArray(files.data)) {
                    for (let i = 0; i < files.data.length; i++) {
                        if (files.data[i].name == path.basename(file_path)) {
                            return files.data[i].sha
                        }
                    }
                }
            } catch (error) {
                console.log("could not find file sha", error)
            }

            return undefined
        }

        const uploadFile = async (filename: string, filecontent: Buffer): Promise<string> => {
            const old_sha = await findFileSha(filename)

            if (old_sha) {
                core.info(`Uploading file ${filename} (old sha ${old_sha})`)
            } else {
                core.info(`Uploading file ${filename} (first time)`)
            }

            const short_sha = commit_sha.substring(0, 5)
            const file_path = path.join(artifacts_dir, filename)

            let get_inter_link = () => {
                const repo_url = `https://github.com/${context.repo.owner}/${context.repo.repo}`
                
                return `

Pull request: ${repo_url}/pull/${context.issue.number}
Commit: ${repo_url}/commit/${commit_sha}`
            }

            const message = `Upload ${file_path} (${short_sha})${inter_link ? get_inter_link() : ""}`;

            await artifacts_octokit.rest.repos.createOrUpdateFileContents({
                owner: artifacts_owner,
                repo: artifacts_repo,
                path: file_path,
                message: message,
                content: filecontent.toString('base64'),
                branch: artifacts_branch,
                sha: old_sha,
            })

            const artifacts_repo_url = `https://github.com/${artifacts_owner}/${artifacts_repo}`
            return `${artifacts_repo_url}/blob/${artifacts_branch}/${file_path}?raw=true`
        }

        let body = `## ${title}\n`

        console.log("Artifact List:", artifact_list);
        if (artifact_list.length == 0) return;
        
        for (let artifact of artifact_list.split(/\n+/)) {
            const artifact_path = artifact.trim()

            const short_path = artifact_path.split('/').slice(-3)
            const content = fs.readFileSync(artifact_path);

            const target_name = artifact_path
            const target_link = await uploadFile(artifact_path, content);

            body += `* [\`${short_path.join("/")}\`](${target_link})`
            body += "\n"
        }

        body += `\nsynchronized with ${commit_sha}`

        if (post_comment) {
            const comment_id = await findComment(title)
            if (comment_id) {
                await updateComment(comment_id, body)
            } else {
                await createComment(body)
            }
        }
    } catch (error) {
        let message = 'Unknown Error'
        if (error instanceof Error) message = error.message
        core.setFailed(message)
    }
}

run()
