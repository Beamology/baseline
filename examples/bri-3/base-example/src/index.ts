import { IBaselineRPC, IBlockchainService, IRegistry, IVault, baselineServiceFactory, baselineProviderProvide } from '@baseline-protocol/api';
import { IMessagingService, messagingProviderNats, messagingServiceFactory } from '@baseline-protocol/messaging';
import { IZKSnarkCircuitProvider, IZKSnarkCompilationArtifacts, IZKSnarkTrustedSetupArtifacts, zkSnarkCircuitProviderServiceFactory, zkSnarkCircuitProviderServiceZokrates, Element, elementify, rndHex, concatenateThenHash } from '@baseline-protocol/privacy';
import { Message as ProtocolMessage, Opcode, PayloadType, marshalProtocolMessage, unmarshalProtocolMessage } from '@baseline-protocol/types';
import { Application as Workgroup, Invite, Vault as ProvideVault, Organization, Token, Key as VaultKey } from '@provide/types';
import { Ident, Vault } from 'provide-js';
import * as jwt from 'jsonwebtoken';
import * as log from 'loglevel';
import { sha256 } from 'js-sha256';
import { AuthService } from 'ts-natsutil';

const baselineProtocolMessageSubject = 'baseline';

export class ParticipantStack {

  private baseline?: IBaselineRPC & IBlockchainService & IRegistry & IVault;
  private baselineCircuitArtifacts?: IZKSnarkCompilationArtifacts;
  private baselineCircuitSetupArtifacts?: IZKSnarkTrustedSetupArtifacts;
  private baselineConfig?: any;
  private babyJubJub?: VaultKey;
  private hdwallet?: VaultKey;
  private initialized = false;
  private nats?: IMessagingService;
  private natsBearerTokens: { [key: string]: any } = {}; // mapping of third-party participant messaging endpoint => bearer token
  private natsConfig?: any;
  private protocolMessagesRx = 0;
  private protocolMessagesTx = 0;
  private protocolSubscriptions: any[] = [];
  private hcsTopics: any;
  private zk?: IZKSnarkCircuitProvider;

  private org?: any;
  private workgroup?: any;
  private workgroupCounterparties: string[] = [];
  private workgroupToken?: any; // workgroup bearer token; used for automated setup
  private workflowIdentifier?: string; // workflow identifier; specific to the workgroup
  private workflowRecords: { [key: string]: any } = {}; // in-memory system of record

  constructor(baselineConfig: any, natsConfig: any) {
    this.baselineConfig = baselineConfig;
    this.natsConfig = natsConfig;
  }

  async init() {
    if (this.initialized) {
      throw new Error(`already initialized participant stack: ${this.org.name}`);
    }

    this.baseline = await baselineServiceFactory(baselineProviderProvide, this.baselineConfig);
    this.nats = await messagingServiceFactory(messagingProviderNats, this.natsConfig);
    this.zk = await zkSnarkCircuitProviderServiceFactory(zkSnarkCircuitProviderServiceZokrates, {});

    if (this.natsConfig?.natsBearerTokens) {
      this.natsBearerTokens = this.natsConfig.natsBearerTokens;
    }

    this.hcsTopics = {};
    this.startProtocolSubscriptions();

    if (this.baselineConfig.initiator) {
      if (this.baselineConfig.workgroup && this.baselineConfig.workgroupToken) {
        await this.setWorkgroup(this.baselineConfig.workgroup, this.baselineConfig.workgroupToken);
      } else if (this.baselineConfig.workgroupName) {
        await this.createWorkgroup(this.baselineConfig.workgroupName);
      }

      await this.registerOrganization(this.baselineConfig.orgName, this.natsConfig.natsServers[0]);
    }

    this.initialized = true;
  }

  getBaselineCircuitArtifacts(): any | undefined {
    return this.baselineCircuitArtifacts;
  }

  getBaselineConfig(): any | undefined {
    return this.baselineConfig;
  }

  getBaselineService(): IBaselineRPC & IBlockchainService & IRegistry & IVault | undefined {
    return this.baseline;
  }

  getMessagingConfig(): any | undefined {
    return this.natsConfig;
  }

  getMessagingService(): IMessagingService | undefined {
    return this.nats;
  }

  getNatsBearerTokens(): { [key: string]: any } {
    return this.natsBearerTokens;
  }

  getOrganization(): any | undefined {
    return this.org;
  }

  getProtocolMessagesRx(): number {
    return this.protocolMessagesRx;
  }

  getProtocolMessagesTx(): number {
    return this.protocolMessagesTx;
  }

  getProtocolSubscriptions(): any[] {
    return this.protocolSubscriptions;
  }

  getWorkflowIdentifier(): any {
    return this.workflowIdentifier;
  }

  getWorkgroup(): any {
    return this.workgroup;
  }

  getWorkgroupTopics(): any {
    return this.hcsTopics;
  }

  getWorkgroupToken(): any {
    return this.workgroupToken;
  }

  getWorkgroupCounterparties(): string[] {
    return this.workgroupCounterparties;
  }

  private async dispatchProtocolMessage(msg: ProtocolMessage): Promise<any> {
    if (msg.opcode === Opcode.Baseline) {
      const vault = await this.requireVault();
      const workflowSignatories = 2;

      // const payload = JSON.parse(msg.payload.toString());
      // if (payload.doc) {
      //   if (!payload.sibling_path) {
      //     payload.sibling_path = [];
      //   }
      //   if (!payload.signatures) {
      //     payload.signatures = [];
      //   }
      //   if (!payload.hash) {
      //     payload.hash = sha256(JSON.stringify(payload.doc));
      //   }

      //   if (payload.signatures.length === 0) {
      //     // baseline this new document
      //     payload.result = await this.generateProof('preimage', JSON.parse(msg.payload.toString()));
      //     const signature = (await this.signMessage(vault.id!, this.babyJubJub?.id!, payload.result.proof.proof)).signature;
      //     payload.signatures = [signature];
      //     this.workgroupCounterparties.forEach(async recipient => {
      //       this.sendProtocolMessage(msg.sender, Opcode.Baseline, payload);
      //     });
      //   } else if (payload.signatures.length < workflowSignatories) {
      //       if (payload.sibling_path && payload.sibling_path.length > 0) {
      //         // perform off-chain verification to make sure this is a legal state transition
      //         const root = payload.sibling_path[0];
      //         const verified = this.baseline?.verify(this.contracts['shield'].address, payload.leaf, root, payload.sibling_path);
      //         if (!verified) {
      //           console.log('WARNING-- off-chain verification of proposed state transition failed...');
      //           this.workgroupCounterparties.forEach(async recipient => {
      //             this.sendProtocolMessage(recipient, Opcode.Baseline, { err: 'verification failed' });
      //           });
      //           return Promise.reject('failed to verify');
      //         }
      //       }

      //       // sign state transition
      //       const signature = (await this.signMessage(vault.id!, this.babyJubJub?.id!, payload.hash)).signature;
      //       payload.signatures.push(signature);
      //       this.workgroupCounterparties.forEach(async recipient => {
      //         this.sendProtocolMessage(recipient, Opcode.Baseline, payload);
      //       });
      //   } else {
      //     // create state transition commitment
      //     payload.result = await this.generateProof('modify_state', JSON.parse(msg.payload.toString()));
      //     console.log(payload);

      //     const leaf = await this.baseline?.insertLeaf(msg.sender, this.contracts['shield'].address, payload.result.proof.proof);
      //     if (leaf) {
      //       console.log(`inserted leaf... ${leaf}`);
      //       payload.sibling_path = (await this.baseline!.getSiblings(msg.shield, leaf.index)).map(node => node.index);
      //       payload.sibling_path?.push(leaf.index);
      //       this.workgroupCounterparties.forEach(async recipient => {
      //         await this.sendProtocolMessage(recipient, Opcode.Baseline, payload);
      //       });
      //   } else {
      //       return Promise.reject('failed to insert leaf');
      //     }
      //   }
      // } else if (payload.signature) {
      //   console.log(`NOOP!!! received signature in BLINE protocol message: ${payload.signature}`);
      // }
    } else if (msg.opcode === Opcode.Join) {
      const payload = JSON.parse(msg.payload.toString());
      const messagingEndpoint = await this.resolveMessagingEndpoint(payload.address);
      if (!messagingEndpoint || !payload.address || !payload.authorized_bearer_token) {
        return Promise.reject('failed to handle baseline JOIN protocol message');
      }
      this.workgroupCounterparties.push(payload.address);
      this.natsBearerTokens[messagingEndpoint] = payload.authorized_bearer_token;
    }
  }

  // HACK!! workgroup/contracts should be synced via protocol
  async acceptWorkgroupInvite(inviteToken: string, hcsTopics: any): Promise<void> {
    if (this.workgroup || this.workgroupToken || this.org || this.baselineConfig.initiator) {
      return Promise.reject('failed to accept workgroup invite');
    }

    const invite = jwt.decode(inviteToken) as { [key: string]: any };

    await this.createWorkgroup(this.baselineConfig.workgroupName);

    this.hcsTopics = hcsTopics; // FIXME!!! read the topics in from Bob's signed token!

    const counterpartyAddr = invite.prvd.data.params.invitor_organization_address;
    this.workgroupCounterparties.push(counterpartyAddr);

    const messagingEndpoint = await this.resolveMessagingEndpoint(counterpartyAddr);
    this.natsBearerTokens[messagingEndpoint] = invite.prvd.data.params.authorized_bearer_token;
    this.workflowIdentifier = invite.prvd.data.params.workflow_identifier;

    await this.baseline?.track(invite.prvd.data.params.shield_contract_address).catch((err) => {});
    await this.registerOrganization(this.baselineConfig.orgName, this.natsConfig.natsServers[0]);
    await this.requireOrganization(await this.resolveOrganizationAddress());
    await this.sendProtocolMessage(counterpartyAddr, Opcode.Join, {
      address: await this.resolveOrganizationAddress(),
      authorized_bearer_token: await this.vendNatsAuthorization(),
      workflow_identifier: this.workflowIdentifier,
    });
  }

  private marshalCircuitArg(val: string, fieldBits?: number): string[] {
    const el = elementify(val) as Element;
    return el.field(fieldBits || 128, 1, true);
  }

  async generateProof(type: string, msg: any): Promise<any> {
    const senderZkPublicKey = this.babyJubJub?.publicKey!;
    let commitment: string;
    let root: string | null = null;
    const salt = msg.salt || rndHex(32);
    if (msg.sibling_path && msg.sibling_path.length > 0) {
      const siblingPath = elementify(msg.sibling_path) as Element;
      root = siblingPath[0].hex(64);
    }

    console.log(`generating ${type} proof...\n`, msg);

    switch (type) {
      case 'preimage': // create agreement
        const preimage = concatenateThenHash({
          // erc20ContractAddress: this.marshalCircuitArg(this.contracts['erc1820-registry'].address),
          senderPublicKey: this.marshalCircuitArg(senderZkPublicKey),
          name: this.marshalCircuitArg(msg.doc.name),
          url: this.marshalCircuitArg(msg.doc.url),
          hash: this.marshalCircuitArg(msg.hash),
        });
        console.log(`generating state genesis with preimage: ${preimage}; salt: ${salt}`);
        commitment = concatenateThenHash(preimage, salt);
        break;

      case 'modify_state': // modify commitment state, nullify if applicable, etc.
        const _commitment = concatenateThenHash({
          senderPublicKey: this.marshalCircuitArg(senderZkPublicKey),
          name: this.marshalCircuitArg(msg.doc.name),
          url: this.marshalCircuitArg(msg.doc.url),
          hash: this.marshalCircuitArg(msg.hash),
        });
        console.log(`generating state transition commitment with calculated delta: ${_commitment}; root: ${root}, salt: ${salt}`);
        commitment = concatenateThenHash(root, _commitment, salt);
        break;

      default:
        throw new Error('invalid proof type');
    }

    const args = [
      this.marshalCircuitArg(commitment), // should == what we are computing in the circuit
      {
        value: [
          this.marshalCircuitArg(commitment.substring(0, 16)),
          this.marshalCircuitArg(commitment.substring(16)),
        ],
        salt: [
          this.marshalCircuitArg(salt.substring(0, 16)),
          this.marshalCircuitArg(salt.substring(16)),
        ],
      },
      {
        senderPublicKey: [
          this.marshalCircuitArg(senderZkPublicKey.substring(0, 16)),
          this.marshalCircuitArg(senderZkPublicKey.substring(16)),
        ],
        agreementName: this.marshalCircuitArg(msg.doc.name),
        agreementUrl: this.marshalCircuitArg(msg.doc.url),
      }
    ];

    const proof = await this.zk?.generateProof(
      this.baselineCircuitArtifacts?.program,
      (await this.zk?.computeWitness(this.baselineCircuitArtifacts!, args)).witness,
      this.baselineCircuitSetupArtifacts?.keypair?.pk,
    );

    return {
      doc: msg.doc,
      proof: proof,
      salt: salt,
    };
  }

  async resolveMessagingEndpoint(addr: string): Promise<string> {
    const org = await this.fetchOrganization(addr);
    if (!org) {
      return Promise.reject(`organization not resolved: ${addr}`);
    }

    const messagingEndpoint = org['config'].messaging_endpoint;
    if (!messagingEndpoint) {
      return Promise.reject(`organization messaging endpoint not resolved for recipient: ${addr}`);
    }

    return messagingEndpoint;
  }

  // bearer auth tokens authorized by third parties are keyed on the messaging endpoint to which access is authorized
  async resolveNatsBearerToken(addr: string): Promise<string> {
    const endpoint = await this.resolveMessagingEndpoint(addr);
    if (!endpoint) {
      return Promise.reject(`failed to resolve messaging endpoint for participant: ${addr}`);
    }
    return this.natsBearerTokens[endpoint];
  }

  // this will accept recipients (string[]) for multi-party use-cases
  async sendProtocolMessage(
    recipient: string,
    opcode: Opcode,
    msg: any,
  ): Promise<any> {
    const messagingEndpoint = await this.resolveMessagingEndpoint(recipient);
    if (!messagingEndpoint) {
      return Promise.reject(`protocol message not sent; organization messaging endpoint not resolved for recipient: ${recipient}`);
    }

    const bearerToken = this.natsBearerTokens[messagingEndpoint];
    if (!bearerToken) {
      return Promise.reject(`protocol message not sent; no bearer authorization cached for endpoint of recipient: ${recipient}`);
    }

    const recipientNatsConn = await messagingServiceFactory(messagingProviderNats, {
      bearerToken: bearerToken,
      natsServers: [messagingEndpoint],
    });
    await recipientNatsConn.connect();

    if (msg.id && !this.workflowRecords[msg.id]) {
      this.workflowRecords[msg.id] = msg;
    }

    // this will use protocol buffers or similar
    const wiremsg = marshalProtocolMessage(
      await this.protocolMessageFactory(
        opcode,
        recipient,
        this.hcsTopics['workgroup'].address, // FIXME -- make constant
        this.workflowIdentifier!,
        Buffer.from(JSON.stringify(msg)),
      ),
    );

    const result = recipientNatsConn.publish(baselineProtocolMessageSubject, wiremsg);
    this.protocolMessagesTx++;
    recipientNatsConn.disconnect();
    return result;
  }

  async createWorkgroup(name: string): Promise<Workgroup> {
    if (this.workgroup) {
      return Promise.reject(`workgroup not created; instance is associated with workgroup: ${this.workgroup.name}`);
    }

    this.workgroup = await this.baseline?.createWorkgroup({
      config: {
        baselined: true,
      },
      name: name,
      network_id: this.baselineConfig?.networkId,
    });

    const tokenResp = await this.createWorkgroupToken();
    this.workgroupToken = tokenResp.accessToken || tokenResp.token;

    if (this.baselineConfig.initiator) {
      await this.initWorkgroup();
    }

    return this.workgroup;
  }

  private async initWorkgroup(): Promise<void> {
    if (!this.workgroup) {
      return Promise.reject('failed to init workgroup');
    }

    // TODO-- create the HCS workgroup topic

    await this.requireWorkgroupTopic('baseline-workgroup-<UUID>'); // FIXME-- setup dynamic workgroup topic key...
  }

  async registerWorkgroupOrganization(): Promise<Organization> {
    if (!this.workgroup || !this.workgroupToken || !this.org) {
      return Promise.reject('failed to register workgroup organization');
    }

    return (await Ident.clientFactory(
      this.workgroupToken,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost,
    )).createApplicationOrganization(this.workgroup.id, {
      organization_id: this.org.id,
    });
  }

  async setWorkgroup(workgroup: any, workgroupToken: any): Promise<void> {
    if (!workgroup || !workgroupToken || !this.workgroup || this.workgroupToken) {
      return Promise.reject('failed to set workgroup');
    }

    this.workgroup = workgroup;
    this.workgroupToken = workgroupToken;

    return this.initWorkgroup();
  }

  async fetchWorkgroupOrganizations(): Promise<Organization[]> {
    if (!this.workgroup || !this.workgroupToken) {
      return Promise.reject('failed to fetch workgroup organizations');
    }

    return (await Ident.clientFactory(
      this.workgroupToken,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost,
    ).fetchApplicationOrganizations(this.workgroup.id, {}));
  }

  async createOrgToken(): Promise<Token> {
    return await Ident.clientFactory(
      this.baselineConfig?.token,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost,
    ).createToken({
      organization_id: this.org.id,
    });
  }

  async createWorkgroupToken(): Promise<Token> {
    return await Ident.clientFactory(
      this.baselineConfig?.token,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost,
    ).createToken({
      application_id: this.workgroup.id,
    });
  }

  async resolveOrganizationAddress(): Promise<string> {
    const keys = await this.fetchKeys();
    if (keys && keys.length >= 3) {
      return keys[2].address; // HACK!
    }
    return Promise.reject('failed to resolve organization address');
  }

  // FIXME? fetchOrganization() can be dropped in favor of `this?.baseline.fetchOrganization(address);`
  async fetchOrganization(address: string): Promise<Organization> {
    return this?.baseline!.fetchOrganizationDetails(address);
  }

  async fetchVaults(): Promise<ProvideVault[]> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    return (await Vault.clientFactory(
      token!,
      this.baselineConfig.vaultApiScheme!,
      this.baselineConfig.vaultApiHost!,
    ).fetchVaults({}));
  }

  async createVaultKey(vaultId: string, spec: string, type?: string, usage?: string): Promise<VaultKey> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    const vault = Vault.clientFactory(
      token!,
      this.baselineConfig?.vaultApiScheme,
      this.baselineConfig?.vaultApiHost,
    );
    return (await vault.createVaultKey(vaultId, {
      'type': type || 'asymmetric',
      'usage': usage || 'sign/verify',
      'spec': spec,
      'name': `${this.org.name} ${spec} keypair`,
      'description': `${this.org.name} ${spec} keypair`,
    }));
  }

  async requireVault(token?: string): Promise<ProvideVault> {
    let vault;
    let tkn = token;
    if (!tkn) {
      const orgToken = await this.createOrgToken();
      tkn = orgToken.accessToken || orgToken.token;
    }

    let interval;
    const promises = [] as any;
    promises.push(new Promise((resolve, reject) => {
      interval = setInterval(async () => {
        const vaults = await Vault.clientFactory(
          tkn!,
          this.baselineConfig.vaultApiScheme!,
          this.baselineConfig.vaultApiHost!,
        ).fetchVaults({});
        if (vaults && vaults.length > 0) {
          vault = vaults[0];
          resolve();
        }
      }, 2500);
    }));

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;

    return vault;
  }

  async signMessage(vaultId: string, keyId: string, message: string): Promise<any> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    const vault = Vault.clientFactory(token!, this.baselineConfig?.vaultApiScheme, this.baselineConfig?.vaultApiHost);
    return (await vault.signMessage(vaultId, keyId, message));
  }

  async fetchKeys(): Promise<any> {
    const orgToken = await this.createOrgToken();
    const token = orgToken.accessToken || orgToken.token;
    const vault = Vault.clientFactory(token!, this.baselineConfig?.vaultApiScheme, this.baselineConfig?.vaultApiHost);
    const vlt = await this.requireVault(token!);
    return (await vault.fetchVaultKeys(vlt.id!, {}));
  }

  async compileBaselineCircuit(): Promise<any> {
    // FIXME-- call Provide Privacy API... (i.e., golang-based API...)
    // TODO: impl privacy package provider for Provide API
    this.baselineCircuitArtifacts = await this.zk?.compile('', 'main'); // FIXME-- use a named circuit
    return this.baselineCircuitArtifacts;
  }

  async deployBaselineCircuit(): Promise<any> {
    // compile the circuit...
    await this.compileBaselineCircuit();

    const setupArtifacts = undefined; // FIXME

    this.baselineCircuitSetupArtifacts = setupArtifacts; // FIXME-- setupArtifacts is never written
    this.workflowIdentifier = ''; // FIXME this.baselineCircuitSetupArtifacts?.identifier;

    this.requireWorkgroupTopic(`baseline-circuit-${this.workflowIdentifier}`); // FIXME-- setup dynamic circuit topic key...
    // FIXME-- do we need to call track() somewhere? -- probably not.. we are "tracking" HCS workflow topic(s) implicitly

    return setupArtifacts;
  }

  async inviteWorkgroupParticipant(email: string): Promise<Invite> {
    return await Ident.clientFactory(
      this.baselineConfig?.token,
      this.baselineConfig?.identApiScheme,
      this.baselineConfig?.identApiHost,
    ).createInvitation({
      application_id: this.workgroup.id,
      email: email,
      permissions: 0,
      params: {
        invitor_organization_address: await this.resolveOrganizationAddress(),
        authorized_bearer_token: await this.vendNatsAuthorization(),
        organization_registry_hcs_topic: this.hcsTopics['organization-registry'].address, // FIXME -- audit hcs topic keys
        workgroup_hcs_topic: this.hcsTopics['workgroup'].address, // FIXME -- audit hcs topic keys
        workflow_hcs_topic: this.hcsTopics['workflow'].address, // FIXME -- audit hcs topic keys
        workflow_identifier: this.workflowIdentifier,
      },
    });
  }

  async requireOrganization(address: string): Promise<Organization> {
    let organization;
    let interval;

    const promises = [] as any;
    promises.push(new Promise((resolve, reject) => {
      interval = setInterval(async () => {
        this.fetchOrganization(address).then((org) => {
          if (org && org['address'].toLowerCase() === address.toLowerCase()) {
            organization = org;
            resolve();
          }
        }).catch((err) => { });
      }, 5000);
    }));

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;

    return organization;
  }

  async requireWorkgroup(): Promise<void> {
    let interval;
    const promises = [] as any;
    promises.push(new Promise((resolve, reject) => {
      interval = setInterval(async () => {
        if (this.workgroup) {
          resolve();
        }
      }, 2500);
    }));

    await Promise.all(promises);
    clearInterval(interval);
    interval = null;
  }

  async requireWorkgroupTopic(type: string): Promise<any> { // FIXME!!
    return Promise.reject(false);
  }

  async registerOrganization(name: string, messagingEndpoint: string): Promise<any> {
    this.org = await this.baseline?.createOrganization({
      name: name,
      metadata: {
        messaging_endpoint: messagingEndpoint,
      },
    });

    if (this.org) {
      const vault = await this.requireVault();
      this.babyJubJub = await this.createVaultKey(vault.id!, 'babyJubJub');
      await this.createVaultKey(vault.id!, 'Ed25519'); // org's "default" key for HCS interactions...
      this.hdwallet = await this.createVaultKey(vault.id!, 'BIP39');
      await this.registerWorkgroupOrganization();
    }

    return this.org;
  }

  async startProtocolSubscriptions(): Promise<any> {
    if (!this.nats?.isConnected()) {
      await this.nats?.connect();
    }

    const subscription = await this.nats?.subscribe(baselineProtocolMessageSubject, (msg, err) => {
      this.protocolMessagesRx++;
      this.dispatchProtocolMessage(unmarshalProtocolMessage(Buffer.from(msg.data)));
    });

    this.protocolSubscriptions.push(subscription);
    return this.protocolSubscriptions;
  }

  async protocolMessageFactory(
    opcode: Opcode,
    recipient: string,
    shield: string,
    identifier: string,
    payload: Buffer,
  ): Promise<ProtocolMessage> {
    const vaults = await this.fetchVaults();
    const signature = (await this.signMessage(
      vaults[0].id!,
      this.hdwallet!.id!,
      sha256(payload.toString()),
    )).signature;

    return {
      opcode: opcode,
      sender: await this.resolveOrganizationAddress(),
      recipient: recipient,
      shield: shield,
      identifier: identifier,
      signature: signature,
      type: PayloadType.Text,
      payload: payload,
    };
  }

  async vendNatsAuthorization(): Promise<string> {
    const authService = new AuthService(
      log,
      this.natsConfig?.audience || this.natsConfig.natsServers[0],
      this.natsConfig?.privateKey,
      this.natsConfig?.publicKey,
    );

    const permissions = {
      publish: {
        allow: ['baseline.>'],
      },
      subscribe: {
        allow: [`baseline.inbound`],
      },
    };

    return await authService.vendBearerJWT(
      baselineProtocolMessageSubject,
      5000,
      permissions,
    );
  }
}
