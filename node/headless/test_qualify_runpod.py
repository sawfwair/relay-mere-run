import importlib.util
import base64
import io
import itertools
import json
import pathlib
import tempfile
import unittest
import time
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('qualifier', pathlib.Path(__file__).with_name('qualify-runpod.py'))
qualifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualifier)


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode() if not isinstance(value, bytes) else value)


class QualificationTests(unittest.TestCase):
    def test_reviewed_image_manifest_is_the_default_and_explicit_pin_overrides_it(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = pathlib.Path(directory) / 'release-image.json'
            reviewed = 'registry.example/node@sha256:' + 'a' * 64
            override = 'registry.example/node@sha256:' + 'b' * 64
            manifest.write_text(json.dumps({'image': reviewed}))
            self.assertEqual(qualifier.resolve_image(manifest_path=manifest), reviewed)
            self.assertEqual(qualifier.resolve_image(override, manifest), override)

    def test_mutable_or_incomplete_image_references_are_rejected(self):
        for value in ['registry.example/node:latest', 'node@sha256:abc', 'node@sha256:' + 'a' * 63]:
            with self.assertRaises(ValueError):
                qualifier.resolve_image(value)

    def test_approved_auth_missing_or_wrong_scope_fails_before_rental(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'auth.json'
            with self.assertRaises(FileNotFoundError):
                qualifier.approved_node_auth(path)
            payload = base64.urlsafe_b64encode(json.dumps({'client_id': 'another-app', 'sub': 'owner', 'exp': time.time() + 3600}).encode()).decode().rstrip('=')
            path.write_text(json.dumps({'access_token': 'header.' + payload + '.signature'}))
            path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'mererun-node grant'):
                qualifier.approved_node_auth(path)

    def test_oversized_progress_frame_does_not_lose_terminal_marker(self):
        progress = json.dumps({'source': 'container', 'line': 'x' * 2000}).encode()
        terminal = json.dumps({'source': 'container', 'line': 'NODE_QUALIFICATION_EXIT=0'}).encode()
        stream = io.BytesIO(b'data: ' + progress + b'\n\ndata: ' + terminal + b'\n\n')
        entries = list(qualifier.log_entries(stream, max_frame_bytes=128))
        self.assertEqual(entries[-1]['line'], 'NODE_QUALIFICATION_EXIT=0')
        self.assertTrue(entries[0]['truncated'])

    def run_scenario(self, ambiguous, restart=False, marker_matches=True, account=False, placement=True, hook_success=True, gpu=None, capacity_rejected=False, reconciliation_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'env').write_text('RUNPOD_API_KEY=test-api-secret')
            (root / 'password').write_text('test-registry-secret')
            payload = base64.urlsafe_b64encode(json.dumps({'client_id': 'mererun-node', 'sub': 'owner', 'exp': time.time() + 3600}).encode()).decode().rstrip('=')
            node_access = 'header.' + payload + '.signature'
            (root / 'node-auth').write_text(json.dumps({'access_token': node_access, 'refresh_token': 'test-refresh-secret'}))
            (root / 'node-auth').chmod(0o600)
            requests = []
            pod_created = False
            deleted = False
            owned_name = None
            log_count = 0

            def respond(request, timeout=None):
                nonlocal pod_created, deleted, owned_name, log_count
                body = json.loads(request.data) if request.data else None
                requests.append((request.full_url, request.get_method(), body))
                if request.full_url.endswith('/api/status'):
                    return Response({'placement_constraints': ['required_device_id'] if placement else [],
                                     'agents': [{'device_name': owned_name, 'device_id': 'owned-node'}] if owned_name else []})
                if request.full_url.endswith('/graphql'):
                    if 'gpuTypes' in body['query']:
                        return Response({'data': {'gpuTypes': [{'id': 'NVIDIA A40', 'securePrice': 0.49}, {'id': 'NVIDIA RTX A6000', 'securePrice': 0.53}, {'id': 'NVIDIA L40', 'securePrice': 0.82}]}})
                    if capacity_rejected:
                        return Response({'errors': [{'message': 'No capacity available'}], 'data': {'podFindAndDeployOnDemand': None}})
                    pod_created = True
                    owned_name = body['variables']['input']['name']
                    if ambiguous:
                        raise TimeoutError('unknown create outcome')
                    return Response({'data': {'podFindAndDeployOnDemand': {'id': 'owned-pod', 'costPerHr': 0.51}}})
                if '/logs?' in request.full_url:
                    log_count += 1
                    if account:
                        return Response(b'data: {"source":"container","line":"node connected"}\n\n')
                    lines = ['NODE_QUALIFICATION_EXIT=0']
                    if restart:
                        kind = 'CREATED' if log_count == 1 else 'RESTORED'
                        marker = 'same-marker' if log_count == 1 or marker_matches else 'different-marker'
                        lines.insert(0, 'NODE_QUALIFICATION_PRIVATE_STATE_' + kind + '=' + marker)
                    return Response(b''.join(b'data: ' + json.dumps({'line': line, 'source': 'container', 'ts': str(log_count)}).encode() + b'\n\n' for line in lines))
                if request.full_url.endswith('/pods/owned-pod/restart'):
                    return Response(None)
                if request.full_url.endswith('/pods/owned-pod'):
                    deleted = True
                    return Response(None)
                if request.full_url.endswith('/pods'):
                    if reconciliation_fails:
                        raise TimeoutError('reconciliation unavailable')
                    pods = [{'id': 'unrelated', 'name': 'existing-work'}]
                    if pod_created and not deleted:
                        pods.append({'id': 'owned-pod', 'name': owned_name})
                    return Response(pods)
                if request.full_url.endswith('/containerregistryauth'):
                    return Response({'id': 'owned-auth'} if request.get_method() == 'POST' else [])
                if request.full_url.endswith('/containerregistryauth/owned-auth'):
                    return Response(None)
                self.fail('Unexpected request: ' + request.full_url)

            output = io.StringIO()
            argv = ['qualify', '--image', 'example/image@sha256:' + 'a' * 64, '--registry-password-file', str(root / 'password'),
                    '--registry-username', 'account', '--env-file', str(root / 'env'), '--receipt-dir', str(root / 'receipt'), '--execute']
            if gpu:
                argv += ['--gpu', gpu]
            if restart:
                argv.append('--restart-probe')
            if account:
                argv += ['--node-auth-file', str(root / 'node-auth')]

            class Hook:
                def __init__(self, command, **options):
                    report = pathlib.Path(options['env']['QUALIFICATION_REPORT_DIR'])
                    report.mkdir()
                    (report / 'receipt.json').write_text(json.dumps({'status': 'passed' if hook_success else 'failed', 'artifactDelivered': hook_success}))
                    self.returncode = 0 if hook_success else 1
                def poll(self):
                    return self.returncode

            class Opener:
                def open(self, request, timeout=None):
                    return respond(request, timeout)

            clock = itertools.count(time.time(), 10 if capacity_rejected else 0.01)
            with patch('time.time', side_effect=lambda: next(clock)), patch('time.sleep'), patch('sys.argv', argv), patch('urllib.request.urlopen', side_effect=respond), patch('urllib.request.build_opener', return_value=Opener()), patch('subprocess.Popen', Hook), patch('sys.stdout', output):
                result = qualifier.main()
            receipt = json.loads((root / 'receipt/receipt.json').read_text())
            if account and not placement:
                self.assertFalse(any(method == 'POST' for _, method, _ in requests))
                self.assertEqual(result, 1)
                return
            if capacity_rejected:
                if reconciliation_fails:
                    self.assertGreater(receipt['estimatedComputeUSD'], 0)
                    self.assertTrue(receipt['podReconciliationFailed'])
                else:
                    self.assertEqual(receipt['estimatedComputeUSD'], 0)
                self.assertNotIn('podId', receipt)
                self.assertTrue(receipt['registryAuthDeleted'])
                self.assertEqual(result, 1)
                self.assertEqual(sum(bool(body and body.get('variables')) for _, _, body in requests), 1)
                return
            self.assertTrue(receipt['podDeleted'])
            self.assertTrue(receipt['registryAuthDeleted'])
            mutations = [r for r in requests if r[2] and 'variables' in r[2] and r[2]['variables']]
            self.assertEqual(len(mutations), 1, 'ambiguous creation must never be replayed')
            config = mutations[0][2]['variables']['input']
            self.assertIn('terminateAfter', config)
            self.assertEqual(config['gpuCount'], 1)
            selected_gpu = gpu or 'NVIDIA A40'
            self.assertEqual(config['gpuTypeId'], selected_gpu)
            self.assertEqual(receipt['gpu'], selected_gpu)
            self.assertEqual(receipt['quotedGPUCostPerHourUSD'], {'NVIDIA A40': 0.49, 'NVIDIA RTX A6000': 0.53, 'NVIDIA L40': 0.82}[selected_gpu])
            self.assertEqual(receipt['maxDurationSeconds'], 3600)
            self.assertEqual(receipt['budgetUSD'], 20)
            self.assertEqual(config['minMemoryInGb'], 48)
            self.assertEqual(config['allowedCudaVersions'], ['12.9', '13.0'])
            hosting = next(item['value'] for item in config['env'] if item['key'] == 'MERERUN_NODE_HOSTING_LABEL')
            self.assertIn(selected_gpu.removeprefix('NVIDIA '), hosting)
            self.assertFalse(any('/unrelated' in r[0] for r in requests))
            for secret in ['test-api-secret', 'test-registry-secret', node_access, 'test-refresh-secret']:
                self.assertNotIn(secret, output.getvalue())
                self.assertNotIn(secret, json.dumps(receipt))
            self.assertEqual(result, 1 if ambiguous or not marker_matches or not hook_success else 0)
            if account:
                self.assertTrue(receipt['relayAdmissionAndPlacementPreflightPassed'])
                self.assertEqual(receipt['relayJobQualified'], hook_success)
                self.assertEqual(json.loads(config['dockerArgs'])['cmd'][0], 'run')
            if restart:
                self.assertEqual(receipt['privateStateRestored'], marker_matches)
                self.assertEqual(sum(url.endswith('/restart') for url, _, _ in requests), 1)

    def test_explicit_a6000_propagates_without_automatic_fallback(self):
        self.run_scenario(False, gpu='NVIDIA RTX A6000')

    def test_explicit_l40_propagates_without_automatic_fallback(self):
        self.run_scenario(False, gpu='NVIDIA L40')

    def test_unknown_gpu_rejected_before_credentials_or_api(self):
        argv = ['qualify', '--gpu', 'NVIDIA H100', '--registry-password-file', 'unused',
                '--registry-username', 'unused', '--receipt-dir', 'unused', '--execute']
        with patch('sys.argv', argv), patch('sys.stderr', io.StringIO()), patch.object(qualifier, 'credential') as credential, patch('urllib.request.urlopen') as api:
            with self.assertRaises(SystemExit) as error:
                qualifier.main()
        self.assertEqual(error.exception.code, 2)
        credential.assert_not_called()
        api.assert_not_called()

    def test_rejected_capacity_does_not_estimate_compute_for_absent_pod(self):
        self.run_scenario(False, capacity_rejected=True)

    def test_failed_reconciliation_does_not_claim_zero_compute(self):
        self.run_scenario(False, capacity_rejected=True, reconciliation_fails=True)

    def test_changed_private_state_marker_fails_and_still_removes_resources(self):
        self.run_scenario(False, restart=True, marker_matches=False)

    def test_account_hook_requires_live_placement_before_any_paid_mutation(self):
        self.run_scenario(False, account=True, placement=False)

    def test_account_hook_passes_bootstrap_privately_and_always_removes_owned_pod(self):
        self.run_scenario(False, account=True)

    def test_account_hook_failure_still_removes_owned_pod(self):
        self.run_scenario(False, account=True, hook_success=False)

    def test_provider_restart_requires_matching_private_state_marker(self):
        self.run_scenario(False, restart=True)

    def test_success_removes_only_owned_resources_and_redacts_credentials(self):
        self.run_scenario(False)

    def test_unknown_create_outcome_reconciles_without_duplicate_then_cleans_up(self):
        self.run_scenario(True)


if __name__ == '__main__':
    unittest.main()
