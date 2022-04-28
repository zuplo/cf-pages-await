import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch, { Response } from 'node-fetch';

import { context } from '@actions/github/lib/utils';
import { ApiResponse, Deployment } from './types';

let waiting = true;
let ghDeployment;
let markedAsInProgress = false;
import { ApiResponse, Deployment } from './types';

export default async function run() {
  const apiKey = core.getInput('apiKey', { required: true, trimWhitespace: true });
  const accountId = core.getInput('accountId', { required: true, trimWhitespace: true });
  const project = core.getInput('project', { required: true, trimWhitespace: true });
  const token = core.getInput('githubToken', { required: false, trimWhitespace: true });
  const commitHash = core.getInput('commitHash', { required: false, trimWhitespace: true });

  console.log('Waiting for Pages to finish building...');
  let lastStage = '';

  while (waiting) {
    // We want to wait a few seconds, don't want to spam the API :)
    await sleep();

    const deployment: Deployment|undefined = await pollApi(apiKey, accountId, project, commitHash);
    if (!deployment) {
      console.log('Waiting for the deployment to start...');
      continue;
    }

    const latestStage = deployment.latest_stage;

    if (latestStage.name !== lastStage) {
      lastStage = deployment.latest_stage.name;
      console.log('# Now at stage: ' + lastStage);

      if (!markedAsInProgress) {
        await updateDeployment(token, deployment, 'in_progress');
        markedAsInProgress = true;
      }
    }

    if (latestStage.status === 'failed') {
      waiting = false;
      core.setFailed(`Deployment failed on step: ${latestStage.name}!`);
      await updateDeployment(token, deployment, 'failure');
      return;
    }

    if (latestStage.name === 'deploy' && ['success', 'failed'].includes(latestStage.status)) {
      waiting = false;

      const aliasUrl = deployment.aliases && deployment.aliases.length > 0 ? deployment.aliases[0] : deployment.url;

      // Set outputs
      core.setOutput('id', deployment.id);
      core.setOutput('environment', deployment.environment);
      core.setOutput('url', deployment.url);
      core.setOutput('alias', aliasUrl);
      core.setOutput('success', deployment.latest_stage.status === 'success' ? true : false);

      // Update deployment (if enabled)
      if (token !== '') {
        await updateDeployment(token, deployment, latestStage.status === 'success' ? 'success' : 'failure');
      }
    }
  }
}

async function pollApi(apiKey: string, accountId: string, project: string, commitHash: string): Promise<Deployment|undefined> {
  // curl -X GET "https://api.cloudflare.com/client/v4/accounts/:account_id/pages/projects/:project_name/deployments" \
  //   -H "X-Auth-Email: user@example.com" \
  //   -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
  let res: Response;
  let body: ApiResponse;
  // Try and fetch, may fail due to a network issue
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments?sort_by=created_on&sort_order=desc`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      }
    });
  } catch(e) {
    // @ts-ignore
    core.error(`Failed to send request to CF API - network issue? ${e.message}`);
    // @ts-ignore
    core.setFailed(e);
    return;
  }

  // If the body isn't a JSON then fail - CF seems to do this sometimes?
  try {
    body = await res.json() as ApiResponse;
  } catch(e) {
    core.error(`CF API did not return a JSON (possibly down?) - Status code: ${res.status} (${res.statusText})`);
    // @ts-ignore
    core.setFailed(e);
    return;
  }

  if (!body.success) {
    waiting = false;
    const error = body.errors.length > 0 ? body.errors[0] : 'Unknown error!';
    core.setFailed(`Failed to check deployment status! Error: ${JSON.stringify(error)}`);
    return;
  }

  if (!commitHash) return body.result?.[0];
  return body.result?.find?.(deployment => deployment.deployment_trigger?.metadata?.commit_hash === commitHash);
}

async function sleep() {
  return new Promise((resolve) => setTimeout(resolve, 5000));
}

// Credits to Greg for this code <3
async function updateDeployment(token: string, deployment: Deployment, state: 'success'|'failure'|'in_progress') {
  if (!token) return;

  const octokit = github.getOctokit(token);

  const environment = deployment.environment === 'production'
    ? 'Production'
    : `Preview (${deployment.deployment_trigger.metadata.branch})`;

  const sharedOptions = {
    owner: context.repo.owner,
    repo: context.repo.repo,
  };

  if (!ghDeployment) {
    const { data } = await octokit.rest.repos.createDeployment({
      ...sharedOptions,
      ref: deployment.deployment_trigger.metadata.commit_hash,
      auto_merge: false,
      environment,
      production_environment: deployment.environment === 'production',
      description: 'Cloudflare Pages',
      required_contexts: [],
    });
    ghDeployment = data;
  }

  if (deployment.latest_stage.name === 'deploy' && ['success', 'failed'].includes(deployment.latest_stage.status)) {
    // @ts-ignore - Env is not typed correctly
    await octokit.rest.repos.createDeploymentStatus({
      ...sharedOptions,
      // @ts-ignore - Typing createDeployment is a pain
      deployment_id: ghDeployment.id,
      // @ts-ignore - Env is not typed correctly
      environment,
      environment_url: deployment.url,
      log_url: `https://dash.cloudflare.com?to=/:account/pages/view/${deployment.project_name}/${deployment.id}`,
      description: 'Cloudflare Pages',
      state,
    });
  }
}

try {
  run();
} catch(e) {
  console.error('Please report this! Issues: https://github.com/WalshyDev/cf-pages-await/issues')
  core.setFailed(e);
  console.error(e.message + '\n' + e.stack);
}
