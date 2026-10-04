#!/usr/bin/env python3
"""Bounded GPU-only preflight; does not enroll or claim a Relay job.

Requires explicit image and a pull-only registry credential file. Credentials
are never part of the receipt. Only resources created by this run are deleted.
"""
import argparse
import base64
import datetime as dt
import json
import os
import pathlib
import re
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise RuntimeError('Redirect rejected for credential-bearing API request')


def credential(path):
    raw = pathlib.Path(path).read_text()
    match = re.search(r'^\s*(?:export\s+)?RUNPOD_API_KEY=(.*)$', raw, re.M)
    if not match:
        raise RuntimeError('RUNPOD_API_KEY is absent')
    return shlex.split(match.group(1))[0]


def approved_node_auth(path):
    """Only a dedicated, already-approved device grant may bootstrap a paid Node."""
    source = pathlib.Path(path)
    if source.stat().st_mode & 0o077:
        raise RuntimeError('Node auth file must have owner-only permissions')
    tokens = json.loads(source.read_text())
    payload = tokens['access_token'].split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    if claims.get('client_id') != 'mererun-node' or not claims.get('sub') or claims.get('exp', 0) < time.time() + 600:
        raise RuntimeError('Approved mererun-node grant must have at least ten minutes remaining')
    # Claim parsing is a local format/scope check. Relay validates signature and
    # current admission before any registry credential or Pod is created.
    return tokens


def log_entries(stream, max_frame_bytes=1024 * 1024):
    """Bounded SSE decoder; huge CR-only progress lines must not abort a Pod."""
    fields = []
    size = 0
    truncated = False
    while True:
        raw = stream.readline(max_frame_bytes + 1)
        if not raw:
            return
        if len(raw) > max_frame_bytes:
            truncated = True
            while raw and not raw.endswith(b'\n'):
                raw = stream.readline(max_frame_bytes + 1)
            continue
        line = raw.rstrip(b'\r\n')
        if not line:
            if truncated:
                yield {'source': 'qualification', 'line': '[Oversized log frame omitted]', 'truncated': True}
            elif fields:
                try:
                    entry = json.loads(b'\n'.join(fields))
                    if isinstance(entry, dict):
                        yield entry
                except json.JSONDecodeError:
                    yield {'source': 'qualification', 'line': '[Malformed log frame omitted]', 'truncated': True}
            fields, size, truncated = [], 0, False
        elif line.startswith(b'data:') and not truncated:
            value = line[5:].lstrip(b' ')
            size += len(value)
            if size > max_frame_bytes:
                truncated = True
                fields = []
            else:
                fields.append(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--registry-password-file', required=True)
    parser.add_argument('--registry-username', required=True)
    parser.add_argument('--env-file', default=str(pathlib.Path.home() / '.env'))
    parser.add_argument('--receipt-dir', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--restart-probe', action='store_true')
    parser.add_argument('--state-only', action='store_true', help='Private state/restart only; no model download or inference')
    parser.add_argument('--node-auth-file', help='Explicit dedicated approved grant; runs the real Node instead of preflight')
    parser.add_argument('--account-hook', help='Executable full-chain qualifier; receives QUALIFICATION_* environment only')
    args = parser.parse_args()
    if not args.execute:
        parser.error('--execute is required to create paid resources')
    if '@sha256:' not in args.image:
        parser.error('Use an immutable image digest')
    if args.node_auth_file and (args.state_only or args.restart_probe):
        parser.error('Account mode cannot be combined with standalone preflight probes')
    if args.account_hook and (not args.node_auth_file or not os.access(args.account_hook, os.X_OK)):
        parser.error('--account-hook requires approved auth and an executable file')
    node_auth = approved_node_auth(args.node_auth_file) if args.node_auth_file else None
    key = credential(args.env_file)
    password = pathlib.Path(args.registry_password_file).read_text().strip()
    # Wrangler output may include a banner; the caller must supply the token only.
    if not password or any(c.isspace() for c in password):
        parser.error('Registry credential file must contain only the password')
    secrets = [key, password] + ([node_auth['access_token'], node_auth.get('refresh_token', '')] if node_auth else [])

    def redact(value):
        for secret in secrets:
            if secret:
                value = value.replace(secret, '[redacted]')
        return value
    root = pathlib.Path(args.receipt_dir)
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    name = 'animatic-node-qualification-' + uuid.uuid4().hex[:12]
    receipt = {'name': name, 'image': args.image, 'purpose': 'Private state/restart only' if args.state_only else 'GPU runtime preflight only',
               'relayJobQualified': False, 'gpu': 'NVIDIA A40', 'gpuCount': 1,
               'maxDurationSeconds': 3600, 'budgetUSD': 20, 'status': 'starting'}
    if node_auth:
        receipt['purpose'] = 'Dedicated approved Node account qualification'
    registry_id = pod_id = None
    started = None
    hook_process = None
    hook_log = None

    def save():
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def api(url, body=None, method=None):
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
            method=method, headers={'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json', 'User-Agent': 'animatic-node-qualification/1.0'})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
            return json.loads(data) if data else None

    def gql(query, variables=None):
        result = api('https://api.runpod.io/graphql', {'query': query, 'variables': variables or {}})
        if result.get('errors'):
            # API errors can echo inputs. Preserve only message types, never bodies.
            raise RuntimeError(redact('; '.join(str(e.get('message', 'GraphQL error')) for e in result['errors'])))
        return result['data']

    def relay_status():
        request = urllib.request.Request('https://relay.mere.run/api/status', headers={
            'Authorization': 'Bearer ' + node_auth['access_token'],
            'User-Agent': 'animatic-node-qualification/1.0'})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            return json.load(response)

    try:
        if node_auth:
            status = relay_status()
            if 'required_device_id' not in status.get('placement_constraints', []):
                raise RuntimeError('Live Relay lacks enforced node placement; no paid resources created')
            receipt['relayAdmissionAndPlacementPreflightPassed'] = True
        catalog = gql('{ gpuTypes { id securePrice } }')['gpuTypes']
        quote = next(g for g in catalog if g['id'] == receipt['gpu'])
        price = float(quote['securePrice'])
        if not 0 < price <= 1:
            raise RuntimeError('GPU quote exceeds the qualification rate limit')
        receipt['quotedGPUCostPerHourUSD'] = price
        save()
        registry = api('https://rest.runpod.io/v1/containerregistryauth',
            {'name': name, 'username': args.registry_username, 'password': password})
        registry_id = registry['id']
        receipt['registryAuthId'] = registry_id
        save()
        termination = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()
        config = {'name': name, 'cloudType': 'SECURE', 'gpuTypeId': receipt['gpu'],
            'gpuCount': 1, 'imageName': args.image, 'containerRegistryAuthId': registry_id,
            'containerDiskInGb': 30, 'volumeInGb': 70, 'volumeMountPath': '/data',
            'dockerArgs': json.dumps({'cmd': ['state-preflight' if args.state_only else 'gpu-preflight'], 'entrypoint': ['/usr/local/bin/node-container-entrypoint']}), 'startSsh': False, 'startJupyter': False,
            'supportPublicIp': False, 'allowedCudaVersions': ['12.9', '13.0'],
            'minMemoryInGb': 48, 'minVcpuCount': 4, 'terminateAfter': termination,
            'env': [{'key': 'MERERUN_NODE_NAME', 'value': name},
                    {'key': 'MERERUN_NODE_HOSTING_KIND', 'value': 'runpod'},
                    {'key': 'MERERUN_NODE_HOSTING_LABEL', 'value': 'RunPod A40 qualification'}]}
        if node_auth:
            config['dockerArgs'] = json.dumps({'cmd': ['run', '--state-dir', '/home/node/.local/share/mere-run-node'],
                'entrypoint': ['/usr/local/bin/node-container-entrypoint']})
            config['env'].append({'key': 'MERERUN_NODE_BOOTSTRAP_AUTH', 'value': json.dumps(node_auth)})
        receipt['terminateAfter'] = termination
        save()
        started = time.time()
        pod = gql('mutation($input:PodFindAndDeployOnDemandInput){podFindAndDeployOnDemand(input:$input){id costPerHr desiredStatus}}', {'input': config})['podFindAndDeployOnDemand']
        pod_id = pod['id']
        receipt.update({'podId': pod_id, 'costPerHourUSD': float(pod['costPerHr']), 'status': 'running',
                        'startedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
        save()
        if receipt['costPerHourUSD'] > 1.1:
            raise RuntimeError('Assigned total rate exceeds qualification limit')
        print(json.dumps({'podId': pod_id, 'costPerHourUSD': receipt['costPerHourUSD'], 'terminateAfter': termination}), flush=True)
        seen = set()
        logs = root / 'container.log'
        terminal = False
        while time.time() - started < 3500 and not terminal:
            if node_auth:
                if hook_process is None:
                    status = relay_status()
                    owned = [a for a in status.get('agents', []) if a.get('device_name') == name]
                    if len(owned) > 1:
                        raise RuntimeError('Qualification Node name is not unique')
                    if owned:
                        device_id = owned[0]['device_id']
                        receipt['deviceId'] = device_id
                        environment = dict(os.environ, QUALIFICATION_NODE_ID=device_id,
                            QUALIFICATION_NODE_NAME=name, QUALIFICATION_NODE_AUTH_FILE=str(pathlib.Path(args.node_auth_file).resolve()),
                            QUALIFICATION_POD_ID=pod_id, QUALIFICATION_REPORT_DIR=str(root.resolve() / 'account-proof'),
                            QUALIFICATION_RELAY_SCRIPT=str(pathlib.Path(__file__).with_name('qualify-relay.py').resolve()))
                        command = [args.account_hook] if args.account_hook else [sys.executable,
                            str(pathlib.Path(__file__).with_name('qualify-relay.py')), '--execute', '--revoke-owned-node',
                            '--auth-file', args.node_auth_file, '--device-id', device_id,
                            '--expected-node-name', name, '--receipt-dir', str(root / 'account-proof')]
                        hook_log = (root / 'account-hook.log').open('wb')
                        hook_process = subprocess.Popen(command, env=environment, stdout=hook_log, stderr=subprocess.STDOUT,
                            start_new_session=True)
                        receipt['accountHookStarted'] = True
                        save()
                elif hook_process.poll() is not None:
                    receipt['accountHookExitCode'] = hook_process.returncode
                    proof = root / 'account-proof' / 'receipt.json'
                    result = json.loads(proof.read_text()) if proof.exists() else {}
                    passed = hook_process.returncode == 0 and result.get('status') == 'passed' and result.get('artifactDelivered') is True
                    if args.account_hook:
                        passed = passed and result.get('animaticDeliveryQualified') is True
                    receipt['relayJobQualified'] = passed
                    receipt['animaticDeliveryQualified'] = passed and result.get('animaticDeliveryQualified') is True
                    receipt['status'] = 'passed' if passed else 'account-qualification-failed'
                    terminal = True
                    continue
            url = f'https://api.runpod.io/v2/pods/{pod_id}/logs?tail=1000'
            request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + key,
                'Accept': 'text/event-stream', 'User-Agent': 'animatic-node-qualification/1.0'})
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    until = time.time() + 20
                    for entry in log_entries(response):
                        if time.time() >= until:
                            break
                        if entry.get('truncated'):
                            receipt['omittedOversizedLogFrames'] = receipt.get('omittedOversizedLogFrames', 0) + 1
                        line = redact(entry.get('line', ''))
                        entry['line'] = line
                        identity = (entry.get('ts'), entry.get('source'), line)
                        if identity in seen:
                            continue
                        seen.add(identity)
                        with logs.open('a') as out:
                            out.write(json.dumps(entry) + '\n')
                        if 'NODE_QUALIFICATION_' in line:
                            print(line, flush=True)
                        if 'NODE_QUALIFICATION_STAGE=image-smoke-passed' in line:
                            receipt['imageSmokePassed'] = True
                        if line.startswith('NODE_QUALIFICATION_PRIVATE_STATE_CREATED='):
                            receipt['privateStateMarker'] = line.split('=', 1)[1]
                        if line.startswith('NODE_QUALIFICATION_PRIVATE_STATE_RESTORED='):
                            receipt['privateStateRestored'] = line.split('=', 1)[1] == receipt.get('privateStateMarker')
                        if 'NODE_QUALIFICATION_EXIT=' in line:
                            success = 'NODE_QUALIFICATION_EXIT=0' in line
                            if success and args.restart_probe and not receipt.get('restartRequested'):
                                if not receipt.get('privateStateMarker'):
                                    raise RuntimeError('Private state marker absent; cannot qualify restart')
                                api('https://rest.runpod.io/v1/pods/' + pod_id + '/restart', method='POST')
                                receipt['restartRequested'] = True
                                print('NODE_QUALIFICATION_STAGE=provider-restart', flush=True)
                                break
                            success = success and (not args.restart_probe or receipt.get('privateStateRestored', False))
                            receipt['status'] = 'passed' if success else 'qualification-failed'
                            terminal = True
                            break
            except (TimeoutError, socket.timeout, urllib.error.URLError):
                pass
            save()
            if not terminal:
                time.sleep(10)
        if not terminal:
            receipt['status'] = 'deadline-exceeded'
    except KeyboardInterrupt:
        receipt['status'] = 'interrupted'
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['errorType'] = type(error).__name__
        receipt['errorMessage'] = redact(str(error))
        print('Qualification failed: ' + type(error).__name__, flush=True)
    finally:
        if hook_process and hook_process.poll() is None:
            import signal
            os.killpg(hook_process.pid, signal.SIGTERM)
            try:
                hook_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(hook_process.pid, signal.SIGKILL)
                hook_process.wait(timeout=5)
        if hook_log:
            hook_log.close()
            path = root / 'account-hook.log'
            path.write_text(redact(path.read_text(errors='replace')))
        # Reconcile unknown POST outcomes by the unique name; never replay a create.
        if started and not pod_id:
            try:
                pods = api('https://rest.runpod.io/v1/pods')
                owned = [p for p in pods if p.get('name') == name]
                if len(owned) == 1:
                    pod_id = owned[0]['id']
                    receipt['podId'] = pod_id
            except Exception:
                receipt['podReconciliationFailed'] = True
        if pod_id:
            receipt['podDeleted'] = False
            for attempt in range(3):
                try:
                    api('https://rest.runpod.io/v1/pods/' + pod_id, method='DELETE')
                    remaining = api('https://rest.runpod.io/v1/pods')
                    receipt['podDeleted'] = all(p['id'] != pod_id for p in remaining)
                    if receipt['podDeleted']:
                        break
                except urllib.error.HTTPError as error:
                    if error.code == 404:
                        receipt['podDeleted'] = True
                        break
                except Exception:
                    pass
                time.sleep(2)
        if not registry_id:
            try:
                registries = api('https://rest.runpod.io/v1/containerregistryauth')
                owned = [r for r in registries if r.get('name') == name]
                if len(owned) == 1:
                    registry_id = owned[0]['id']
                    receipt['registryAuthId'] = registry_id
            except Exception:
                receipt['registryReconciliationFailed'] = True
        if registry_id:
            try:
                api('https://rest.runpod.io/v1/containerregistryauth/' + registry_id, method='DELETE')
                receipt['registryAuthDeleted'] = True
            except Exception:
                receipt['registryAuthDeleted'] = False
        if started:
            receipt['elapsedSeconds'] = round(time.time() - started, 2)
            receipt['estimatedComputeUSD'] = round(receipt.get('costPerHourUSD', 1.1) * receipt['elapsedSeconds'] / 3600, 4)
            receipt['billingNote'] = 'Elapsed-rate estimate; final billing/storage require provider billing reconciliation.'
        save()
        print(json.dumps(receipt), flush=True)
    return 0 if receipt['status'] == 'passed' and receipt.get('podDeleted') else 1


if __name__ == '__main__':
    raise SystemExit(main())
